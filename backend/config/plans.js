/**
 * Plan definitions (master plan section 46).
 *
 * Every limit the product enforces lives here so the numbers can be reviewed in
 * one place instead of scattered through the services. Values are defaults; an
 * operator can override any of them through the environment, which keeps the
 * limits adjustable without a deploy.
 *
 * The limits are deliberately conservative. They exist to stop a single account
 * from running up an unbounded bill, not to be a pricing strategy.
 */

/** Built-in plans. `free` is the default; `pro` is set by an admin or billing. */
export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    // How many people can be in one team workspace. Personal workspaces cannot be
    // shared at all, so they ignore this. Three is the smallest number that makes
    // a team worth having.
    maxMembers: 3,
    maxWorkspaces: 2,
    maxDocuments: 25,
    storageBytes: 100 * 1024 * 1024,
    // Usage quotas, enforced before the expensive call happens.
    aiPerMonth: 20,
    aiPerDay: 10,
    ocrPerMonth: 10,
    voiceMinutesPerDay: 30,
    /** Priority is a hint for queueing, not a promise. */
    priority: "standard",
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 15,
    maxMembers: 50,
    maxWorkspaces: 25,
    maxDocuments: 5000,
    storageBytes: 20 * 1024 * 1024 * 1024,
    aiPerMonth: 2000,
    aiPerDay: 250,
    ocrPerMonth: 500,
    voiceMinutesPerDay: 240,
    priority: "fast",
  },
};

export const DEFAULT_PLAN = "free";

function num(envKey, fallback) {
  const raw = process.env[envKey];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Resolve a plan with environment overrides applied.
 *
 * @param {string} [planId]
 * @returns {typeof PLANS.free}
 */
export function planFor(planId) {
  const base = PLANS[planId] || PLANS[DEFAULT_PLAN];

  // Overrides are opt-in per plan, so setting one never silently changes another.
  const prefix = planId === "pro" ? "PLAN_PRO" : "PLAN_FREE";
  return {
    ...base,
    maxMembers: num(`${prefix}_MAX_MEMBERS`, base.maxMembers),
    maxWorkspaces: num(`${prefix}_MAX_WORKSPACES`, base.maxWorkspaces),
    maxDocuments: num(`${prefix}_MAX_DOCUMENTS`, base.maxDocuments),
    storageBytes: num(`${prefix}_STORAGE_BYTES`, base.storageBytes),
    aiPerMonth: num(`${prefix}_AI_PER_MONTH`, base.aiPerMonth),
    aiPerDay: num(`${prefix}_AI_PER_DAY`, base.aiPerDay),
    ocrPerMonth: num(`${prefix}_OCR_PER_MONTH`, base.ocrPerMonth),
    voiceMinutesPerDay: num(`${prefix}_VOICE_MINUTES_PER_DAY`, base.voiceMinutesPerDay),
  };
}

/** The plan and its limits, ready to show in a UI. */
export function describePlan(planId) {
  const plan = planFor(planId);
  return {
    id: plan.id,
    name: plan.name,
    priceMonthly: plan.priceMonthly,
    maxMembers: plan.maxMembers,
    maxWorkspaces: plan.maxWorkspaces,
    maxDocuments: plan.maxDocuments,
    storageBytes: plan.storageBytes,
    aiPerMonth: plan.aiPerMonth,
    aiPerDay: plan.aiPerDay,
    ocrPerMonth: plan.ocrPerMonth,
    voiceMinutesPerDay: plan.voiceMinutesPerDay,
    priority: plan.priority,
  };
}

/** Public catalogue for the pricing table. */
export function planCatalogue() {
  return Object.keys(PLANS).map((id) => describePlan(id));
}

/**
 * Human-readable reason a workspace has hit a plan ceiling, or null when it is
 * still within limits. Phrased so the UI can show it directly.
 */
export function describeLimitBreach(planId, counts = {}) {
  const plan = planFor(planId);
  if (counts.documents != null && counts.documents >= plan.maxDocuments) {
    return `This workspace already has ${counts.documents} documents, which is the ${plan.name} limit of ${plan.maxDocuments}.`;
  }
  if (counts.members != null && counts.members >= plan.maxMembers) {
    return `This workspace already has ${counts.members} members, which is the ${plan.name} limit of ${plan.maxMembers}.`;
  }
  if (counts.storageBytes != null && counts.storageBytes >= plan.storageBytes) {
    return "This workspace has used all of its storage.";
  }
  return null;
}