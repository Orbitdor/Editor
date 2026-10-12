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
      .connect(process.env.MONGO_URI, {
        // The hosted cluster idles connections out, so allow the driver time to
        // pick a server again instead of failing the first request it wakes up.
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000,
        maxPoolSize: 20,
        minPoolSize: 2,
        // Retry transient topology errors rather than surfacing them to callers.
        retryReads: true,
        retryWrites: true,
      })
      .then(() => true)
      .catch((err) => {
        lastError = err.message;
        cached = null;
        return false;
      });
  }
  return cached;
};