import * as voiceService from "../services/voice.service.js";

/**
 * Voice / dictation HTTP layer.
 *
 * Controllers stay thin: they only pull fields off the request and hand them to
 * the service, which owns authorization, quotas and persistence.
 */

// GET /api/v1/voice/status -> provider capability + remaining daily minutes
export const getStatus = async (req, res) => {
  res.json(await voiceService.voiceStatus(req.user.id));
};

// POST /api/v1/documents/:id/voice/transcribe -> server-side audio transcription
export const transcribe = async (req, res) => {
  const { audio, language, durationSeconds, provider } = req.body || {};
  res.json(
    await voiceService.transcribeClip(req.params.id, req.user.id, {
      audio,
      language,
      durationSeconds,
      provider,
    })
  );
};

// POST /api/v1/documents/:id/voice/finish -> clean up a browser-side transcript
export const finish = async (req, res) => {
  const { transcript, language, durationSeconds, provider } = req.body || {};
  res.json(
    await voiceService.finishDictation(req.params.id, req.user.id, {
      transcript,
      language,
      durationSeconds,
      provider,
    })
  );
};

// GET /api/v1/documents/:id/voice -> recent dictation sessions
export const listSessions = async (req, res) => {
  res.json(await voiceService.listTranscriptions(req.params.id, req.user.id, req.query.limit));
};

// GET /api/v1/documents/:id/voice/:transcriptionId -> one session
export const getSession = async (req, res) => {
  res.json(
    await voiceService.getTranscription(req.params.id, req.params.transcriptionId, req.user.id)
  );
};
