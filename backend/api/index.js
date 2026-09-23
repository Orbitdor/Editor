import "dotenv/config";
import app, { connectDB } from "../app.js";

connectDB();

export default app;