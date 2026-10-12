import User from "../../models/User.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { claimInvitations, ensurePersonalWorkspace } from "../../services/workspace.service.js";
import { attachCookies, startSession } from "../../services/token.service.js";

export const Login = async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) throw new ApiError(400, "Email or password is incorrect");

  const ok = await user.comparePassword(password);
  if (!ok) throw new ApiError(400, "Email or password is incorrect");

  user.lastLoginAt = new Date();
  await user.save();

  // Every sign-in opens a device session. The browser keeps the tokens in
  // HttpOnly cookies; the access token is still echoed so API clients work.
  const { accessToken, refreshToken } = await startSession(user, req);
  attachCookies(res, { accessToken, refreshToken });

  // Sign-in is the natural moment to settle workspace state: the personal space is
  // created if it is missing, and any invitation addressed to this address is
  // claimed. Both are cheap and never block the login.
  await Promise.all([
    ensurePersonalWorkspace(user).catch(() => null),
    claimInvitations(user).catch(() => []),
  ]);

  res.json({
    message: "Login successful",
    token: accessToken,
    user: { id: user._id, name: user.name, email: user.email },
  });
};

export default Login;