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
        // A paused free-tier cluster can take longer than 15s to accept the
        // first connection, so the ceiling is generous.
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 30000,
        maxPoolSize: 20,
        minPoolSize: 2,
        // Retry transient topology errors rather than surfacing them to callers.
        retryReads: true,
        retryWrites: true,
      })
      .then(() => true)
      .catch(async (err) => {
        lastError = err.message;
        cached = null;
        // A failed attempt can leave a half-open connection behind. Tear it
        // down so the next request starts clean instead of reusing a dead
        // socket, which is what lets the API recover from a transient DNS or
        // network blip without a full restart.
        await mongoose.disconnect().catch(() => {});
        return false;
      });
  }
  return cached;
};