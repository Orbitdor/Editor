import app, { connectDB } from "./app.js";

connectDB().finally(() => {
  app.listen(process.env.PORT || 5000, () => {
    console.log(`API running on port ${process.env.PORT || 5000}`);
  });
});