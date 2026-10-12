import User from "../../models/User.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { claimInvitations, ensurePersonalWorkspace } from "../../services/workspace.service.js";
import { attachCookies, startSession } from "../../services/token.service.js";

export const Register = async (req, res) => {
  const { name, email, password } = req.body;

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new ApiError(409, "Email already exists");

  const user = await User.create({ name, email, password });

  // Registration is also a sign-in, so it opens a session exactly as login does.
  const { accessToken, refreshToken } = await startSession(user, req);
  attachCookies(res, { accessToken, refreshToken });

  // Someone who was invited before they had an account joins that workspace now
  // rather than having to accept a separate invite afterwards.
  await claimInvitations(user).catch(() => []);
  await ensurePersonalWorkspace(user).catch(() => null);

  res.status(201).json({
    message: "User registered successfully",
    token: accessToken,
    user: { id: user._id, name: user.name, email: user.email },
  });
};

export default Register;