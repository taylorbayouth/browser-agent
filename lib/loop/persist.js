'use strict';

const { saveMetadata } = require('./refs');
const { compactPreview } = require('./format');

// Persist a turn's observations to the scratchpad and strip heavy payloads from
// what re-enters the model's context. Mutates each obs.detail in place: image
// base64 / file bytes are written to assets/ and dropped, full save_text content
// is replaced by a bounded preview, and savedPath is recorded for the event log.
//
// Read-only screenshots still return pixels for vision, but their base64 is
// removed here and never lands in assets/ unless the model called save_image.
async function persistObservations({ observations, validActions, brief, scratchpad, runArtifact, cfg }) {
  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const action = validActions[i] || {};
    const stepId = runArtifact.steps.length + i + 1;
    if (obs.detail?.image) {
      if (obs.verb === 'save_image') {
        const saved = await scratchpad.saveImage({
          base64: obs.detail.image,
          title: brief.title,
          url: brief.url,
          description: obs.detail.description,
          hint: action.args?.hint,
          id: stepId,
          ext: obs.detail.ext || 'png',
          reason: action.args?.intent,
          resize: cfg.images || {},
          metadata: saveMetadata(brief, action, { source_url: obs.detail.sourceUrl }),
        });
        obs.detail.savedPath = saved?.path || null;
      }
      delete obs.detail.image;
    }
    if (obs.verb === 'save_text' && obs.detail) {
      const preview = compactPreview(obs.detail.content);
      const saved = scratchpad.saveText({
        content: obs.detail.content,
        summary: obs.detail.summary,
        url: brief.url,
        reason: action.args?.intent,
        metadata: saveMetadata(brief, action),
      });
      obs.detail.savedPath = saved?.path || null;
      obs.detail.preview = preview || null;
      delete obs.detail.content;   // keep only the model's summary in context
    }
    if (obs.verb === 'save_record' && obs.detail) {
      const saved = scratchpad.saveRecord({
        metadata: obs.detail.metadata,
        title: brief.title,
        url: brief.url,
        reason: action.args?.intent,
      });
      obs.detail.savedPath = saved?.path || null;
    }
    if (obs.verb === 'save_file' && obs.detail?.fileBytes) {
      const saved = scratchpad.saveAsset({
        base64: obs.detail.fileBytes,
        filename: obs.detail.filename,
        summary: obs.detail.description || obs.detail.summary,
        url: obs.detail.sourceUrl,
        hint: action.args?.hint,
        id: stepId,
        reason: action.args?.intent,
        metadata: saveMetadata(brief, action, { source_url: obs.detail.sourceUrl }),
      });
      obs.detail.savedPath = saved?.path || null;
      delete obs.detail.fileBytes;   // bytes stay on disk; only the summary re-enters context
    }
  }
}

module.exports = { persistObservations };
