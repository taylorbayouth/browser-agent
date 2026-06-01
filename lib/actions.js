'use strict';

// Single source of truth for the action vocabulary. The validator, executor,
// and prompt builder all read from this registry.
//
// Schema per verb:
//   requiresRef: bool    — does this verb target an element ref?
//   refType:    string[] — allowed ref-type letters (e.g. ['e']). Required iff requiresRef.
//   args:       object   — arg name → type. Trailing '?' on type marks optional.
//
// Argument types accepted by the validator:
//   'string', 'number', 'boolean', plus the '?' suffix for optional.
//
// See DESIGN.md § Action registry for the full contract.

const ACTIONS = {
  click: {
    requiresRef: true,
    refType: ['e', 't'],
    args: {},
    description: 'Click node center. Use @t only when the clickable item appears only as text in a clickable container.',
  },
  type: {
    requiresRef: true,
    refType: ['e'],
    args: { text: 'string', clear: 'boolean?', submit: 'boolean?' },
    description: 'Focus and type. Does NOT submit unless submit:true presses Enter. Default replaces field value; clear:false appends.',
  },
  scroll: {
    requiresRef: false,
    args: { direction: 'string', amount: 'number?' },
    description: 'Scroll page. direction: up|down|left|right; amount: pixels, default ~85% viewport.',
  },
  press: {
    requiresRef: false,
    args: { key: 'string' },
    description: 'Press key at current focus: Enter, Tab, Escape, ArrowDown, etc.',
  },
  navigate: {
    requiresRef: false,
    args: { url: 'string' },
    description: 'Load URL in current tab. Bare host is fine. Invalidates all prior refs.',
  },
  back: {
    requiresRef: false,
    args: {},
    description: 'Browser Back. Use after opening detail pages to return to results/listings instead of re-searching. Invalidates refs.',
  },
  wait: {
    requiresRef: false,
    args: { ms: 'number' },
    description: 'Pause for animations, debounced/throttled UI, or external steps. ms capped at 30000; settle still runs.',
  },
  select_text: {
    requiresRef: true,
    refType: ['e', 't'],
    args: {},
    changesPage: false,
    description: 'Select/read full node text, not a sub-phrase. To keep it after navigation, follow with save_text.',
  },
  take_screenshot: {
    requiresRef: false,
    optionalRef: true,
    refType: ['e', 't', 'v'],
    args: {},
    changesPage: false,
    idempotentRead: true,
    description: 'Inspect/read pixels; does not create a report asset. Crop-first: pass an exact visible @v/@e/@t ref — never punctuation, selectors, words, or coordinates; no ref grabs the whole viewport (rare fallback). Use for charts, diagrams, canvas, scans, CAPTCHAs, or image text when you need to understand what it shows. For report images/photos, use save_image.',
  },
  save_image: {
    requiresRef: true,
    refType: ['e', 't', 'v'],
    args: {},
    changesPage: false,
    idempotentRead: true,
    description: 'Save a visible image/visual as a report asset. Pass the exact @v/@e/@t ref for the selected photo, chart, product shot, profile image, diagram, or other visual. Uses original loaded image bytes when available, otherwise saves a cropped rendered image. Use this for photo/image deliverables before save_record/done.',
  },
  get_files: {
    requiresRef: false,
    args: {},
    changesPage: false,
    idempotentRead: true,
    description: 'List linked downloads (PDFs, sheets, archives, etc.): URL and type. Then save_file(url); do not navigate directly.',
  },
  save_text: {
    requiresRef: false,
    args: { content: 'string', summary: 'string' },
    changesPage: false,
    description: 'Save facts/source material needed later. content = full text; summary = short, specific memory shown later. Do not use save_text for final deliverable records or intermediate answer drafts; use save_record for complete final records and done for final.',
  },
  save_record: {
    requiresRef: false,
    args: { content: 'string', summary: 'string' },
    changesPage: false,
    description: 'Save one complete final deliverable record — one item, with whatever contract fields you have gathered; a missing field is acceptable, do not loop hunting for it. For photo/image/media records, include the saved asset path from save_image/save_file, not only a source URL. content = full record; summary = short record label shown later. Each save_record increments record progress.',
  },
  save_file: {
    requiresRef: false,
    args: { url: 'string' },
    changesPage: false,
    description: 'Download a file by URL from get_files or a visible link (PDF, sheet, archive, etc.); records name/type/size. For on-page visuals use save_image instead. intent is the saved reason.',
  },
  done: {
    requiresRef: false,
    args: { result: 'string?' },
    description: 'Complete the task. result is final answer; only finish from content actually read, not guesses. Corroborate key single-source facts or mark low-confidence.',
  },
};

module.exports = ACTIONS;
