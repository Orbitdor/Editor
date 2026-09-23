import mongoose from "mongoose";

let cached = null;
let lastError = null;

export const getDBError = () => lastError;

export const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    lastError = null;
    return true;
  }
  if (!process.env.MONGO_URI) {
    lastError = "MONGO_URI is not set";
    return false;
  }
  if (!cached) {
    cached = mongoose
      .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 })
      .then(() => true)
      .catch((err) => {
        lastError = err.message;
        cached = null;
        return false;
      });
  }
  return cached;
};