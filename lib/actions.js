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
    refType: ['e', 't', 'r'],
    args: { hint: 'string?' },
    changesPage: false,
    idempotentRead: true,
    description: 'Capture for vision inspection only; does not save assets. No ref = visible viewport. To crop, pass exact visible @e/@t/@r; never pass punctuation, CSS selectors, words, or coordinates as ref. Use save_image when the visual belongs in the report. hint focuses description.',
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
    description: 'Save facts/source material needed later. content = full text; summary = short, specific memory shown later. Do not use save_text for intermediate answer drafts; use done for final.',
  },
  save_file: {
    requiresRef: false,
    args: { url: 'string', hint: 'string?' },
    changesPage: false,
    description: 'Download/save URL from get_files or a visible link. Images get vision description; other files get name/type/size. hint focuses image description.',
  },
  save_image: {
    requiresRef: false,
    optionalRef: true,
    refType: ['e', 't', 'r', 'v'],
    args: { hint: 'string?' },
    changesPage: false,
    description: 'Save an image into report assets. Use @v for a discovered image URL, @r for an unreadable visual region, @e/@t for a crop, or no ref for the viewport. Use only when the visual itself belongs in the final report.',
  },
  save_record: {
    requiresRef: false,
    args: { metadata: 'string?' },
    changesPage: false,
    description: 'Close the current record: attach all unassigned saved text/files/images to one completed record. metadata should be compact JSON or plain text for the record.',
  },
  done: {
    requiresRef: false,
    args: { result: 'string?' },
    description: 'Complete the task. result is final answer; only finish from content actually read, not guesses. Corroborate key single-source facts or mark low-confidence.',
  },
};

module.exports = ACTIONS;
