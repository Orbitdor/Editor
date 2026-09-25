import jwt from "jsonwebtoken";
import User from "../../models/User.model.js";
import { ApiError } from "../../utils/ApiError.js";

const SECRET = process.env.JWT_SECRET || "dev-secret";

export const Login = async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new ApiError(400, "Email or password is incorrect");

  const ok = await user.comparePassword(password);
  if (!ok) throw new ApiError(400, "Email or password is incorrect");

  const token = jwt.sign({ id: user._id, email: user.email }, SECRET, {
    expiresIn: "7d",
  });

  res.json({
    message: "Login successful",
    token,
    user: { id: user._id, name: user.name, email: user.email },
  });
};

export default Login;