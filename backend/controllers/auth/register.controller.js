import jwt from "jsonwebtoken";
import User from "../../models/User.model.js";
import { ApiError } from "../../utils/ApiError.js";

const SECRET = process.env.JWT_SECRET || "dev-secret";

export const Register = async (req, res) => {
  const { name, email, password } = req.body;

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new ApiError(409, "Email already exists");

  const user = await User.create({ name, email, password });
  const token = jwt.sign({ id: user._id, email: user.email }, SECRET, {
    expiresIn: "7d",
  });

  res.status(201).json({
    message: "User registered successfully",
    token,
    user: { id: user._id, name: user.name, email: user.email },
  });
};

export default Register;