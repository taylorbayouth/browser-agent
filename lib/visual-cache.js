'use strict';

const VISUAL_EVIDENCE = Symbol('browser-agent.visualEvidence');

function setVisualEvidence(region, evidence) {
  if (!region || !evidence) return region;
  Object.defineProperty(region, VISUAL_EVIDENCE, {
    value: evidence,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return region;
}

function getVisualEvidence(region) {
  return region?.[VISUAL_EVIDENCE] || null;
}

module.exports = { setVisualEvidence, getVisualEvidence, VISUAL_EVIDENCE };
