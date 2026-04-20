import serverless from "serverless-http";
import app from "../backend/server.js";

export default serverless(app);
