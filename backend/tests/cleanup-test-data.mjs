/**
 * Remove data created by the collaboration test runs.
 *
 * The tests register timestamped users with a known prefix and documents owned
 * by them, so they leave real rows behind in the development database.
 *
 * Not part of `npm test`: run it by hand after test runs you do not want to
 * keep in the development database.
 *
 * Usage: node --env-file=.env tests/cleanup-test-data.mjs
 */
import mongoose from "mongoose";
import User from "../models/User.model.js";
import Document from "../models/doc.model.js";
import Share from "../models/Share.model.js";
import Comment from "../models/Comment.model.js";
import Notification from "../models/Notification.model.js";
import OCRJob from "../models/OCRJob.model.js";
import VoiceTranscription from "../models/VoiceTranscription.model.js";
import AIUsage from "../models/AIUsage.model.js";
import GoogleConnection from "../models/GoogleConnection.model.js";
import Workspace from "../models/Workspace.model.js";
import WorkspaceMember from "../models/WorkspaceMember.model.js";
import ActivityLog from "../models/ActivityLog.model.js";
import Attachment from "../models/Attachment.model.js";
import Folder from "../models/Folder.model.js";
import Session from "../models/Session.model.js";
import { storage } from "../services/storage.service.js";

// Test accounts are registered with a recognizable email prefix and a timestamp.
// `google.user` covers the accounts created by the Google suite through the
// offline mock, which are named after the authorization code rather than a
// test prefix.
//
// The `.test.local` rule is the reliable one: RFC 2606 reserves that domain for
// testing, so no real account can live there, and it catches suites that invent
// their own prefixes (session, folder, ...) without this file having to know
// every one of them.
const USER_PREFIXES = ["sprint2", "sprint3", "sprint4", "sprint5", "google.user", "ws", "dbg"];
const TEST_DOMAIN = /@test\.local$/i;

await mongoose.connect(process.env.MONGO_URI);

const users = await User.find({
  $or: [
    { email: new RegExp(`^(${USER_PREFIXES.join("|")})`, "i") },
    { email: TEST_DOMAIN },
  ],
})
  .select("_id email")
  .lean();
const userIds = users.map((u) => u._id);
console.log(`test users found: ${userIds.length}`);

if (userIds.length) {
  const docs = await Document.find({ owner: { $in: userIds } }).select("_id").lean();
  const docIds = docs.map((d) => d._id);

  // Workspaces owned by (or invited to) a test account, including teams whose only
  // owner happens to be one. The audit log and memberships go with them, otherwise
  // the next run would trip over the one-personal-workspace-per-user index.
  const workspaces = await Workspace.find({ owner: { $in: userIds } }).select("_id").lean();
  const workspaceIds = workspaces.map((w) => w._id);
  const memberRows = await WorkspaceMember.find({
    $or: [{ user: { $in: userIds } }, { email: { $in: users.map((u) => u.email) } }],
  })
    .select("workspace")
    .lean();
  const allWorkspaceIds = [
    ...new Set([...workspaceIds, ...memberRows.map((m) => String(m.workspace))]),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const shares = await Share.deleteMany({ user: { $in: userIds } });
  const sharedDocs = await Share.deleteMany({ document: { $in: docIds } });
  const comments = await Comment.deleteMany({ document: { $in: docIds } });
  const notifications = await Notification.deleteMany({ actor: { $in: userIds } });
  const ocrJobs = await OCRJob.deleteMany({ document: { $in: docIds } });
  const transcriptions = await VoiceTranscription.deleteMany({ document: { $in: docIds } });
  const usage = await AIUsage.deleteMany({ user: { $in: userIds } });
  const connections = await GoogleConnection.deleteMany({ user: { $in: userIds } });
  const sessions = await Session.deleteMany({ user: { $in: userIds } });
  const members = await WorkspaceMember.deleteMany({ workspace: { $in: allWorkspaceIds } });
  const activity = await ActivityLog.deleteMany({ workspace: { $in: allWorkspaceIds } });
  // Folders hang off the workspace rather than the document, so they are removed
  // before the documents that may still reference one. Attachment rows go with
  // their documents; the files themselves live in the storage provider.
  const folders = await Folder.deleteMany({ workspace: { $in: allWorkspaceIds } });
  // Read the keys before deleting the rows: the bytes live in the storage
  // provider, so removing the metadata alone would leave the files orphaned on
  // disk with nothing pointing at them.
  const orphanKeys = (await Attachment.find({ workspace: { $in: allWorkspaceIds } })
    .select("storageKey")
    .lean()).map((a) => a.storageKey);
  const attachments = await Attachment.deleteMany({ workspace: { $in: allWorkspaceIds } });
  await Promise.all(orphanKeys.map((key) => storage.remove(key).catch(() => null)));
  const removedDocs = await Document.deleteMany({ _id: { $in: docIds } });
  const removedWorkspaces = await Workspace.deleteMany({ _id: { $in: allWorkspaceIds } });
  const removedUsers = await User.deleteMany({ _id: { $in: userIds } });

  console.log(`documents removed: ${removedDocs.deletedCount}`);
  console.log(`users removed: ${removedUsers.deletedCount}`);
  console.log(`shares removed: ${shares.deletedCount + sharedDocs.deletedCount}`);
  console.log(`comments removed: ${comments.deletedCount}`);
  console.log(`notifications removed: ${notifications.deletedCount}`);
  console.log(`ocr jobs removed: ${ocrJobs.deletedCount}`);
  console.log(`transcriptions removed: ${transcriptions.deletedCount}`);
  console.log(`usage buckets removed: ${usage.deletedCount}`);
  console.log(`google connections removed: ${connections.deletedCount}`);
  console.log(`sessions removed: ${sessions.deletedCount}`);
  console.log(`folders removed: ${folders.deletedCount}`);
  console.log(`attachments removed: ${attachments.deletedCount}`);
  console.log(`workspaces removed: ${removedWorkspaces.deletedCount}`);
  console.log(`memberships removed: ${members.deletedCount}`);
  console.log(`activity entries removed: ${activity.deletedCount}`);
} else {
  console.log("nothing to clean");
}

await mongoose.disconnect();
