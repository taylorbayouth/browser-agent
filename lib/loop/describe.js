'use strict';

const { cleanUrl } = require('../url');
const { refName } = require('./refs');
const {
  LOG_URL_MAX, RULE,
  quote, hasText, compactWhitespace, scrollSummary,
} = require('./format');

// Render one action as a past-tense event line for the progress log.
function describeAction(action, brief) {
  const name = refName(brief, action.ref);
  const target = name ? quote(name) : (action.ref || '');
  let line;
  switch (action.verb) {
    case 'navigate': line = action.args?.url ? `navigated to ${cleanUrl(action.args.url, LOG_URL_MAX)}` : 'navigated'; break;
    case 'back': line = 'went back'; break;
    case 'click':  line = hasText(target) ? `clicked ${target}` : 'clicked'; break;
    case 'type': {
      const text = action.args?.text != null ? quote(action.args.text) : '';
      if (hasText(text) && hasText(target)) line = `typed ${text} into ${target}`;
      else if (hasText(text)) line = `typed ${text}`;
      else if (hasText(target)) line = `typed into ${target}`;
      else line = 'typed';
      break;
    }
    case 'scroll': line = `scrolled ${action.args?.direction || 'down'}`; break;
    case 'press':  line = hasText(action.args?.key) ? `pressed ${action.args.key}` : 'pressed'; break;
    case 'wait':   line = action.args?.ms != null ? `waited ${action.args.ms}ms` : 'waited'; break;
    case 'take_screenshot': line = action.args?.hint ? `looked at the page (${action.args.hint})` : 'looked at the page'; break;
    case 'save_text': line = 'saved text'; break;
    case 'save_image': line = hasText(target) ? `saved image ${target}` : 'saved image'; break;
    case 'save_file': line = 'saved file'; break;
    case 'save_record': line = 'saved record'; break;
    case 'get_files': line = 'listed page files'; break;
    case 'select_text': line = hasText(target) ? `selected ${target}` : 'selected text'; break;
    default:       line = `${action.verb}${action.ref ? ' ' + action.ref : ''}`;
  }
  const intent = compactWhitespace(action.args?.intent);
  return intent ? `${line} — intent: ${intent}` : line;
}

// `revisits` is how many times the model has already been on the current page
// before this turn (see run()); >0 triggers a prominent warning so it stops
// looping back to pages whose content is already in the history.
function buildTurnMessage(task, events, llmView, revisits = 0, pivot = null) {
  const progress = events.length
    ? events.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    : '  (nothing yet — this is your first action)';
  const listing = llmView.listing || '(no interactive elements)';
  const url = cleanUrl(llmView.url);
  const revisitNote = revisits >= 1
    ? `   ⚠ REVISIT — you've already been here ${revisits}×; its content is in the History above. Don't re-inspect it: use what you have, or go somewhere new.`
    : '';
  const page = [
    url ? `URL: ${url}${revisitNote}` : null,
    llmView.title ? `Title: ${llmView.title}` : null,
    `Viewport: ${scrollSummary(llmView.viewport)}`,
  ].filter(Boolean).join('\n');
  const pivotBlock = pivot
    ? `\n${RULE}
⮕ REFLECT — act on this now; do not repeat what stalled:
   ${pivot}
${RULE}\n`
    : '';
  return {
    role: 'user',
    content:
`Task: ${task}

${RULE}
History:
${progress}
${RULE}
${pivotBlock}
Page:
${page}

Refs (valid only now):
${listing}

Choose one best next action.`,
  };
}

// Short, clean terminal label for a step — separate from the full event string
// that goes to the model. Only shows what an operator needs at a glance.
function termDesc(action, brief, observation) {
  const name = refName(brief, action.ref);
  const named = (prefix) => name ? `${prefix} "${name}"` : prefix;
  switch (action.verb) {
    case 'navigate':        return `↳ ${cleanUrl(action.args?.url, LOG_URL_MAX) || ''}`;
    case 'click':           return named('Clicked');
    case 'type':            return named('Typed into');
    case 'scroll':          return `Scrolled ${action.args?.direction || 'down'}`;
    case 'press':           return hasText(action.args?.key) ? `Pressed ${action.args.key}` : 'Pressed';
    case 'wait':            return action.args?.ms != null ? `⏱ Waited ${action.args.ms}ms` : '⏱ Waited';
    case 'take_screenshot': return observation?.detail?.cropped ? 'Screenshot (cropped)' : 'Screenshot';
    case 'save_text':       return 'Saved text';
    case 'save_image': {
      if (observation?.detail?.skipped) return 'Skipped image';
      const p = observation?.detail?.savedPath;
      return p ? `Saved image → ${p.split('/').pop()}` : 'Saved image';
    }
    case 'save_file': {
      const p = observation?.detail?.savedPath;
      return p ? `Saved file → ${p.split('/').pop()}` : 'Saved file';
    }
    case 'save_record':     return 'Saved record';
    case 'get_files':       return 'Got files';
    case 'select_text':     return named('Selected');
    case 'done':            return `Done${action.args?.result ? ` — ${action.args.result}` : ''}`;
    default:                return action.verb;
  }
}

// Build the trailing note appended to a step's event line — the outcome detail
// the model sees next turn (failure, selection preview, vision summary, saved
// path). Returns '' when the bare action line already says everything.
function observationNote(step) {
  const obs = step.observation;
  if (obs.status === 'error') return ` — FAILED: ${obs.error}`;
  if (obs.detail?.selectedText != null) {
    // Report what select_text actually highlighted so the model can read it
    // and finish (or save_text it to keep it), instead of re-selecting blind.
    // Only this 200-char preview re-enters the model's context; to persist
    // the full text the model follows up with save_text.
    const sel = obs.detail.selectedText;
    return sel
      ? ` — selected: "${sel.length > 200 ? sel.slice(0, 199) + '…' : sel}"`
      : ' — selected nothing (empty selection)';
  }
  if (obs.detail?.description != null) {
    // Full vision descriptions are saved with artifacts; only the compact
    // summary re-enters prompt history so long runs do not balloon.
    const desc = obs.detail.summary || obs.detail.description;
    let note = step.action.verb === 'save_file' ? ` — "${desc}"` : ` — saw: "${desc}"`;
    // Report the saved file so the model knows the artifact exists.
    const saved = obs.detail.savedPath;
    if (saved) note += step.action.verb === 'save_file' ? ` → ${saved}` : ` — saved image to ${saved}`;
    return note;
  }
  if (obs.detail?.summary != null) {
    // save_text: the full content is on disk; a bounded preview re-enters
    // context so saved facts remain usable after navigation.
    let note = ` — "${obs.detail.summary}"`;
    if (obs.detail.preview) note += ` — saved: "${obs.detail.preview}"`;
    const saved = obs.detail.savedPath;
    if (saved) note += ` → ${saved}`;
    return note;
  }
  if (step.action.verb === 'save_record' && obs.detail?.savedPath) {
    return ` → ${obs.detail.savedPath}`;
  }
  return '';
}

module.exports = {
  describeAction,
  buildTurnMessage,
  termDesc,
  observationNote,
};
