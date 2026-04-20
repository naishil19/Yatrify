import express from "express";
import serverless from "serverless-http";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// Example route
app.get("/api/health", (req, res) => {
  res.json({ status: "OK" });
});

// 👉 Move ALL your routes here

export default serverless(app);