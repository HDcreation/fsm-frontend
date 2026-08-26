// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const multer = require('multer');
const fs = require('fs');

// Create an uploads folder if it doesn't exist
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Configure multer storage
const upload = multer({ dest: 'uploads/' });

const app = express();
const path = require('path');

const JWT_SECRET = process.env.JWT_SECRET || 'FSM_Super_Secret_Key_2026_!@#';

// --- SECURITY: LAYER 2 GATEKEEPER ---
function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(403).json({ error: 'Access Denied: No token provided.' });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).json({ error: 'Unauthorized: Invalid or expired token.' });
        }

        req.user = decoded;
        next();
    });
}

// HELPER: Calculate distance between two coordinates in Kilometers (Haversine Formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
    return R * c; 
}

// Expose the uploads folder to the public web
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(cors());
app.use(express.json());

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)

const { initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
let firebaseMessaging = null;

// Initialize Firebase Cloud Messaging
try {
    if (process.env.FIREBASE_JSON) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_JSON);
        initializeApp({
            credential: cert(serviceAccount)
        });
        firebaseMessaging = getMessaging();
        console.log("🔥 Firebase Admin Initialized Successfully");
    } else {
        console.warn("⚠️ Firebase credentials missing in environment variables.");
    }
} catch (error) {
    console.error("❌ Failed to initialize Firebase:", error);
}

// --- SCHEMAS ---

// 1. User Schema 
const UserSchema = new mongoose.Schema({
    userId: { type: String, unique: true, required: true },
    password: { type: String, required: true }, 
    userName: String,
    role: { type: String, enum: ['admin', 'hr', 'employee'], required: true },
    isCheckedIn: { type: Boolean, default: false },
    lastCheckInTime: Date,
    lastCheckOutTime: Date,
    lastLocation: { 
        lat: Number, 
        lng: Number, 
        timestamp: Date 
    },
    locationHistory: [{
        lat: Number,
        lng: Number,
        timestamp: { type: Date, default: Date.now }
    }],
    fcmToken: { type: String },
    baseSalary: { type: Number, default: 0 },
    allowance: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

// 2. Task Schema (Upgraded with Gig-Economy Timestamps)
const TaskSchema = new mongoose.Schema({
    taskId: { type: String, unique: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    assignedTo: { type: String, required: true }, 
    targetLat: { type: Number },
    targetLng: { type: Number },
    completionLat: { type: Number },
    completionLng: { type: Number },
    customerName: String,
    issueDescription: String,
    location: String,
    status: { type: String, enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'VERIFIED'], default: 'PENDING' },
    travelPath: [{ lat: Number, lng: Number, timestamp: Date }], 
    totalDistance: { type: Number, default: 0 }, 
    
    resolutionNote: String,
    resolutionPhotoUrl: String, 
    proofImagePath: { type: String, default: '' },
    
    createdAt: { type: Date, default: Date.now },
    assignedAt: { type: Date, default: Date.now }, // NEW
    acceptedAt: { type: Date }, // NEW
    completedAt: Date
});
const Task = mongoose.model('Task', TaskSchema);

// --- GOOGLE SHEETS SETUP ---
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const credentials = process.env.GOOGLE_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
    : null;
const auth = credentials
    ? new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    })
    : null;
const sheets = SPREADSHEET_ID && auth
    ? google.sheets({ version: 'v4', auth })
    : null;

// --- MODULE 1: AUTHENTICATION API ---
app.post('/api/login', async (req, res) => {
    const { userId, password } = req.body;
    
    const user = await User.findOne({ userId, password });
    if (user) {
        const token = jwt.sign(
            { userId: user.userId, role: user.role },
            JWT_SECRET,
            { expiresIn: '12h' }
        );

        res.json({ 
            success: true, 
            token,
            user: { 
                id: user.userId, 
                name: user.userName, 
                role: user.role 
            } 
        });
    } else {
        res.status(401).json({ success: false, message: "Invalid credentials" });
    }
});

// --- MODULE 2: DUAL-TRACKING RADAR & ATTENDANCE ---

// RECEIVE LIVE LOCATION (Dual Tracking Enabled)
app.post('/api/radar', verifyToken, async (req, res) => {
    try {
        const { employeeId, latitude, longitude } = req.body;
        const pingTime = new Date();

        if (!employeeId || !latitude || !longitude) {
            return res.status(400).json({ error: 'Missing location data' });
        }

        // TRACKING 1: Shift Tracking (Always log for HR History)
        await User.findOneAndUpdate(
            { userId: employeeId },
            { 
                lastLocation: { lat: Number(latitude), lng: Number(longitude), timestamp: pingTime },
                $push: { locationHistory: { lat: Number(latitude), lng: Number(longitude), timestamp: pingTime } }
            },
            { new: true }
        );

        // TRACKING 2: Fuel/Billable Tracking (Only if working on an active task)
        const activeTask = await Task.findOne({ assignedTo: employeeId, status: 'PROCESSING' });

        if (activeTask) {
            let distanceToAdd = 0;
            if (activeTask.travelPath && activeTask.travelPath.length > 0) {
                const lastPoint = activeTask.travelPath[activeTask.travelPath.length - 1];
                distanceToAdd = calculateDistance(lastPoint.lat, lastPoint.lng, Number(latitude), Number(longitude));
            }

            await Task.findByIdAndUpdate(activeTask._id, {
                $push: { travelPath: { lat: Number(latitude), lng: Number(longitude), timestamp: pingTime } },
                $inc: { totalDistance: distanceToAdd }
            });
        }

        console.log(`📡 Dual-tracked ping received from ${employeeId}`);
        res.status(200).send("Location updated");

    } catch (error) {
        console.error("❌ Live radar error:", error);
        res.status(500).send("Internal Server Error");
    }
});

app.post('/api/radar/batch', verifyToken, async (req, res) => {
    try {
        const locationLogs = req.body; 

        if (!locationLogs || locationLogs.length === 0) {
            return res.status(400).json({ error: 'No batch data provided' });
        }

        const latestLocation = locationLogs[locationLogs.length - 1];

        await User.findOneAndUpdate(
            { userId: latestLocation.employeeId },
            { 
                lastLocation: { lat: latestLocation.latitude, lng: latestLocation.longitude, timestamp: new Date() }
            }
        );

        console.log(`📦 Batch sync complete for ${latestLocation.employeeId}.`);
        res.status(200).send("Batch processed successfully");
    } catch (error) {
        res.status(500).send("Internal Server Error");
    }
});

app.post('/api/attendance', verifyToken, async (req, res) => {
    const { userId, userName, action, lat, lng } = req.body;
    const isCheckedIn = action === 'Check In';
    const serverTimestamp = new Date();

    if (!userId || !['Check In', 'Check Out'].includes(action)) {
        return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    try {
        const updatePayload = {
            isCheckedIn,
            lastLocation: { lat: Number(lat) || 0, lng: Number(lng) || 0, timestamp: serverTimestamp }
        };

        if (isCheckedIn) {
            updatePayload.lastCheckInTime = serverTimestamp;
        } else {
            updatePayload.lastCheckOutTime = serverTimestamp;
        }

        await User.findOneAndUpdate({ userId }, updatePayload, { new: true });

        if (sheets) {
            const timeString = serverTimestamp.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: 'Sheet1!A:E',
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [[userName || userId, action, timeString, Number(lat), Number(lng)]]
                }
            });
        }

        res.json({ success: true, isCheckedIn });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/radar', verifyToken, async (req, res) => {
    try {
        const activeUsers = await User.find(
            { isCheckedIn: true },
            'userName userId lastLocation'
        );
        res.json(activeUsers);
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// HISTORICAL TRAVEL ROUTE API
app.get('/api/users/:userId/history', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const { date } = req.query; 

        if (!date) return res.status(400).json({ error: "Date is required" });

        const user = await User.findOne({ userId });
        if (!user) return res.status(404).json({ error: "User not found" });

        const targetDate = new Date(date);
        const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
        const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

        const dailyRoute = user.locationHistory.filter(loc => {
            const locTime = new Date(loc.timestamp);
            return locTime >= startOfDay && locTime <= endOfDay;
        });

        res.json(dailyRoute);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch travel history" });
    }
});

// --- MODULE 3: SMART TRACKING & TASK API ---

app.get('/api/tasks', verifyToken, async (req, res) => {
    try {
        const tasks = await Task.find().sort({ createdAt: -1 });
        res.status(200).json(tasks);
    } catch (error) {
        res.status(500).send("Server Error");
    }
});

app.get('/api/tasks/:userId', verifyToken, async (req, res) => {
    try {
        const tasks = await Task.find({ 
            assignedTo: req.params.userId, 
            status: { $in: ['PENDING', 'PROCESSING'] } 
        });
        res.json(tasks);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch tasks" });
    }
});

// ACCEPT TASK (Stamps exact gig-economy start time)
app.put('/api/tasks/:taskId/accept', verifyToken, async (req, res) => {
    try {
        await Task.findOneAndUpdate(
            { taskId: req.params.taskId }, 
            { 
                status: 'PROCESSING',
                acceptedAt: new Date() // NEW: Stamps exact start time
            }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to accept task" });
    }
});

// --- TASK RESOLUTION & PROOF OF WORK API ---
app.post('/api/tasks/resolve', verifyToken, upload.single('proofImage'), async (req, res) => {
    try {
        const { taskId } = req.body;
        const imageFile = req.file;

        if (!taskId || !imageFile) {
            return res.status(400).send("Missing task ID or image");
        }

        const taskFilter = mongoose.isValidObjectId(taskId)
            ? { $or: [{ taskId }, { _id: taskId }] }
            : { taskId };
        const taskToResolve = await Task.findOne(taskFilter);

        if (!taskToResolve) {
            return res.status(404).send("Task not found");
        }

        const employee = await User.findOne({ userId: taskToResolve.assignedTo });
        const compLat = employee && employee.lastLocation ? employee.lastLocation.lat : 0;
        const compLng = employee && employee.lastLocation ? employee.lastLocation.lng : 0;
        const compTime = new Date();

        await Task.findOneAndUpdate(
            { _id: taskToResolve._id },
            {
                status: 'COMPLETED',
                proofImagePath: imageFile.path,
                completedAt: compTime,
                completionLat: compLat,
                completionLng: compLng
            }
        );

        res.status(200).send("Task resolved");
    } catch (error) {
        res.status(500).send("Server Error");
    }
});

// --- MODULE 5: HR VERIFICATION & DASHBOARD API ---

app.get('/api/admin/tasks/resolved', verifyToken, async (req, res) => {
    try {
        const tasks = await Task.find({ status: 'COMPLETED' }).sort({ completedAt: -1 });
        res.json(tasks);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch resolved tasks" });
    }
});

app.put('/api/admin/tasks/:taskId/verify', verifyToken, async (req, res) => {
    try {
        await Task.findOneAndUpdate({ taskId: req.params.taskId }, { status: 'VERIFIED' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to verify task" });
    }
});

app.get('/api/users/employees', verifyToken, async (req, res) => {
    try {
        const employees = await User.find({ role: 'employee' });
        res.status(200).json(employees);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch employees" });
    }
});

app.delete('/api/tasks/:taskId', verifyToken, async (req, res) => {
    try {
        const taskFilter = mongoose.isValidObjectId(req.params.taskId)
            ? { $or: [{ taskId: req.params.taskId }, { _id: req.params.taskId }] }
            : { taskId: req.params.taskId };
        await Task.findOneAndDelete(taskFilter);
        res.status(200).json({ success: true, message: "Task removed" });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete task" });
    }
});

app.put('/api/tasks/:taskId/force-complete', verifyToken, async (req, res) => {
    try {
        const taskFilter = mongoose.isValidObjectId(req.params.taskId)
            ? { $or: [{ taskId: req.params.taskId }, { _id: req.params.taskId }] }
            : { taskId: req.params.taskId };
        await Task.findOneAndUpdate(
            taskFilter,
            { status: 'COMPLETED', completedAt: new Date() }
        );
        res.status(200).json({ success: true, message: "Task marked complete" });
    } catch (err) {
        res.status(500).json({ error: "Failed to complete task" });
    }
});

app.post('/api/users/add', verifyToken, async (req, res) => {
    try {
        const { userId, password, userName, role, baseSalary, allowance } = req.body;
        
        const existingUser = await User.findOne({ userId });
        if (existingUser) {
            return res.status(400).json({ error: "User ID already exists!" });
        }

        await User.create({
            userId,
            password, 
            userName,
            role,
            baseSalary: Number(baseSalary) || 0,
            allowance: Number(allowance) || 0
        });

        res.status(200).json({ success: true, message: "Employee successfully added!" });
    } catch (err) {
        res.status(500).json({ error: "Failed to add employee" });
    }
});

// --- MODULE 6: PAYROLL & DISPATCH API ---

let globalFuelRate = 1.5;

app.post('/api/users/update-token', verifyToken, async (req, res) => {
    try {
        const { userId, fcmToken } = req.body;
        if (!userId || !fcmToken) return res.status(400).send("Missing data");

        const user = await User.findOneAndUpdate(
            { userId: userId },
            { fcmToken: fcmToken },
            { new: true }
        );

        if (!user) return res.status(404).send("User not found");
        res.status(200).send("Token updated");
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

app.post('/api/tasks/assign', verifyToken, async (req, res) => {
    try {
        const { employeeId, title, description, targetLat, targetLng } = req.body;

        if (!employeeId || !title || !description) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const newTask = await Task.create({
            taskId: 'TSK-' + Math.floor(1000 + Math.random() * 9000),
            assignedTo: employeeId,
            title,
            description,
            customerName: title,
            issueDescription: description,
            targetLat: targetLat || null, 
            targetLng: targetLng || null,
            status: 'PENDING',
            assignedAt: new Date() // NEW: Timestamps creation
        });

        const employee = await User.findOne({ userId: employeeId });
        if (employee && employee.fcmToken && firebaseMessaging) {
            const message = {
                notification: { title: `New Task: ${title}`, body: description },
                android: { notification: { sound: 'default', channelId: 'FSM_TASK_ALERTS' } },
                token: employee.fcmToken
            };

            await firebaseMessaging.send(message);
        }

        res.status(200).json({ message: "Task assigned and saved successfully!", task: newTask });
    } catch (error) {
        res.status(500).json({ error: "Failed to assign task" });
    }
});

app.post('/api/settings/fuelRate', verifyToken, (req, res) => {
    if (req.body.rate) {
        globalFuelRate = Number(req.body.rate);
    }
    res.json({ success: true, newRate: globalFuelRate });
});

app.get('/api/payroll', verifyToken, async (req, res) => {
    try {
        const employees = await User.find({ role: 'employee' });
        const payrollReport = [];

        for (let emp of employees) {
            const verifiedTasks = await Task.find({ 
                assignedTo: emp.userId, 
                status: 'VERIFIED'
            });

            const totalDistance = verifiedTasks.reduce((sum, task) => sum + task.totalDistance, 0);
            const fuelReimbursement = totalDistance * globalFuelRate;
            const totalPay = emp.baseSalary + emp.allowance + fuelReimbursement;

            payrollReport.push({
                name: emp.userName || emp.userId,
                baseSalary: emp.baseSalary,
                allowance: emp.allowance,
                totalDistance: totalDistance.toFixed(2), 
                fuelReimbursement: Math.round(fuelReimbursement),
                totalPay: Math.round(totalPay)
            });
        }

        res.json(payrollReport);
    } catch (err) {
        res.status(500).json({ error: "Failed to generate payroll" });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));