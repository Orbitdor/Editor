import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    /**
     * Optional because an account created through "Sign in with Google" has no
     * password (master plan section 9). Local accounts always set it.
     */
    password: {
      type: String,
      default: null,
    },
    /** How the account signs in: `local`, or `google` when it was created by Google. */
    provider: { type: String, enum: ["local", "google"], default: "local" },
    /** Provider's own user id, e.g. the Google `sub`. */
    providerId: { type: String, default: null },
    /** Google identity linked to a pre-existing local account. */
    googleProviderId: { type: String, default: null },
    googleEmail: { type: String, default: null, lowercase: true, trim: true },
    /** Google asserts this only when the `email` scope is granted, which it always is. */
    emailVerified: { type: Boolean, default: false },
    avatar: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.pre("save", async function () {
  // A Google-only account has no password to hash, and `isModified` on a
  // default-valued field would otherwise be false anyway.
  if (!this.password || !this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = function (candidate) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

/** True when the account can sign in with a password. */
userSchema.methods.hasPassword = function () {
  return Boolean(this.password);
};

/** Never expose the password or provider ids in an API response. */
userSchema.set("toJSON", {
  transform(_doc, ret) {
    delete ret.password;
    delete ret.googleProviderId;
    return ret;
  },
});

const User = mongoose.model("User", userSchema);

export default User;