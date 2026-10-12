import AIUsage, { periodKey } from "../models/AIUsage.model.js";
import { ApiError } from "../utils/ApiError.js";
import { DEFAULT_PLAN, planFor } from "../config/plans.js";
import { getWorkspace } from "./workspace.service.js";

/**
 * AI, OCR and voice usage accounting and per-plan quotas (master plan section 46).
 *
 * Every AI, OCR or dictation call records a delta against the user's current
 * bucket. The quota check runs before the expensive call so the user is told they
 * are over the limit instead of the provider bill silently growing.
 *
 * Limits come from the workspace's plan. An explicit environment variable always
 * wins, so an existing deployment keeps its current behaviour after upgrading and
 * the test suite can raise the free tier without a code change.
 */

/** Read an env override, or undefined when it is not set. */
function envNum(key) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The legacy env overrides, now optional. */
const QUOTAS = {
  month: envNum("AI_MONTHLY_QUOTA"),
  day: envNum("AI_DAILY_QUOTA"),
};

/** Dictation is billed in minutes, not requests, so it gets its own ceiling. */
const VOICE_DAY_SECONDS =
  envNum("VOICE_DAILY_MINUTES") === undefined ? undefined : envNum("VOICE_DAILY_MINUTES") * 60;

/**
 * Resolve the limits that apply to a workspace.
 *
 * @param {object|null} workspace A Workspace document, or null when unknown.
 * @returns {{aiPerDay: number, aiPerMonth: number, ocrPerMonth: number, voiceDaySeconds: number, plan: string}}
 */
export async function effectiveLimits(workspace = null) {
  const planId = workspace?.plan || DEFAULT_PLAN;
  const plan = planFor(planId);

  return {
    plan: planId,
    aiPerDay: QUOTAS.day ?? plan.aiPerDay,
    aiPerMonth: QUOTAS.month ?? plan.aiPerMonth,
    ocrPerMonth: plan.ocrPerMonth,
    voiceDaySeconds: VOICE_DAY_SECONDS ?? plan.voiceMinutesPerDay * 60,
  };
}

/** Limits for a user, defaulting to their personal workspace's plan. */
export async function limitsForUser(userId, workspaceId = null) {
  const workspace = workspaceId ? await getWorkspace(workspaceId) : null;
  return effectiveLimits(workspace);
}

/**
 * Current usage for both buckets.
 *
 * @returns {Promise<{day: object, month: object}>}
 */
export async function currentUsage(userId) {
  const today = periodKey(new Date(), "day");
  const month = periodKey(new Date(), "month");
  const rows = await AIUsage.find({ user: userId, period: { $in: [today, month] } }).lean();

  const empty = {
    requests: 0,
    inputChars: 0,
    outputChars: 0,
    ocrJobs: 0,
    voiceSessions: 0,
    voiceSeconds: 0,
  };
  const pick = (key) => rows.find((r) => r.period === key) || empty;

  return { day: pick(today), month: pick(month) };
}

/**
 * Throw a 429 when the caller has already spent their daily or monthly budget.
 * Called before invoking the provider.
 *
 * @param {string} userId
 * @param {object|null} [workspace] The workspace being charged, for its plan.
 */
export async function assertWithinQuota(userId, workspace = null) {
  const limits = await effectiveLimits(workspace);
  const usage = await currentUsage(userId);

  if (usage.day.requests >= limits.aiPerDay) {
    throw new ApiError(429, `Daily AI limit of ${limits.aiPerDay} reached. Try again tomorrow.`);
  }
  if (usage.month.requests >= limits.aiPerMonth) {
    throw new ApiError(429, `Monthly AI limit of ${limits.aiPerMonth} reached. Upgrade the plan for more.`);
  }
}

/**
 * Guard for dictation. Checked against seconds of speech rather than requests,
 * because a single long recording can be far more expensive than a short one.
 *
 * @param {string} userId
 * @param {number} requestedSeconds Length of the clip about to be transcribed.
 * @param {object|null} [workspace]
 */
export async function assertWithinVoiceQuota(userId, requestedSeconds = 0, workspace = null) {
  const limits = await effectiveLimits(workspace);
  const { day } = await currentUsage(userId);

  if (day.voiceSeconds + requestedSeconds > limits.voiceDaySeconds) {
    const minutes = Math.round(limits.voiceDaySeconds / 60);
    throw new ApiError(429, `Daily voice limit of ${minutes} minutes reached. Try again tomorrow.`);
  }
}

/** Guard for OCR, which has its own monthly allowance separate from AI actions. */
export async function assertWithinOcrQuota(userId, workspace = null) {
  const limits = await effectiveLimits(workspace);
  const usage = await currentUsage(userId);
  if (usage.month.ocrJobs >= limits.ocrPerMonth) {
    throw new ApiError(429, `Monthly OCR limit of ${limits.ocrPerMonth} documents reached.`);
  }
}

/**
 * Record one completed call against the day and month buckets.
 *
 * @param {string} userId
 * @param {{inputChars?: number, outputChars?: number, ocr?: boolean, voice?: number, document?: string}} delta
 */
export async function recordUsage(
  userId,
  { inputChars = 0, outputChars = 0, ocr = false, voice = 0, document = null, workspace = null } = {}
) {
  const today = periodKey(new Date(), "day");
  const month = periodKey(new Date(), "month");
  const periods = [today, month];

  // One `$set`, not two: spreading two of them would let the second overwrite the
  // first and lose the document attribution.
  const attribution = {
    ...(document ? { document } : {}),
    ...(workspace ? { workspace } : {}),
  };

  await Promise.all(
    periods.map((period) =>
      AIUsage.findOneAndUpdate(
        { user: userId, period },
        {
          $inc: {
            requests: 1,
            inputChars,
            outputChars,
            ...(ocr ? { ocrJobs: 1 } : {}),
            ...(voice > 0 ? { voiceSessions: 1, voiceSeconds: Math.round(voice) } : {}),
          },
          ...(Object.keys(attribution).length ? { $set: attribution } : {}),
        },
        { upsert: true, new: true }
      ).lean()
    )
  );
}

/**
 * Usage summary for the AI panel header / `GET /api/v1/ai/usage`.
 */
export async function usageSummary(userId, workspace = null) {
  const usage = await currentUsage(userId);
  const limits = await effectiveLimits(workspace);

  return {
    plan: limits.plan,
    day: { requests: usage.day.requests, limit: limits.aiPerDay },
    month: { requests: usage.month.requests, limit: limits.aiPerMonth },
    ocrJobsThisMonth: usage.month.ocrJobs,
    ocr: { used: usage.month.ocrJobs, limit: limits.ocrPerMonth },
    voice: {
      secondsToday: usage.day.voiceSeconds,
      limitSeconds: limits.voiceDaySeconds,
      sessionsThisMonth: usage.month.voiceSessions,
    },
  };
}
