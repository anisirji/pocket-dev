// Adapt MCP's flat form elicitation to the existing chat questions. Unknown/secret-bearing forms are not auto-approved.
const bad = (message) => new Error(message);
const secret = /password|secret|api.?key|access.?token|refresh.?token/i;
export function mcpInputPlan(params) {
  if (params.mode === 'url') {
    let url; try { url = new URL(params.url); } catch { throw bad('The MCP authorization link is invalid.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw bad('The MCP authorization link must be an HTTP or HTTPS address without embedded credentials.');
    return { kind: 'authorization', title: params.message || `Authorize ${params.serverName || 'MCP tool'}`, detail: `Open this link yourself, then continue: ${url.href}` };
  }
  if (params.mode && params.mode !== 'form') throw bad('Complete this tool’s extended authorization in its native client.');
  const schema = params.requestedSchema;
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) throw bad('This tool requires a form that Pocket Dev cannot display.');
  if (Object.keys(schema).some((key) => !['$schema', 'type', 'properties', 'required', 'additionalProperties', 'title', 'description'].includes(key))) throw bad('This tool requires a more complex form. Complete it in the native client.');
  if (JSON.stringify(schema).length > 16000 || Object.keys(schema.properties).length > 20) throw bad('This tool’s form is too large. Complete it in the native client.');
  const required = new Set(schema.required || []), fields = [];
  if (!Array.isArray(schema.required || []) || [...required].some((key) => !Object.hasOwn(schema.properties, key))) throw bad('This tool supplied an invalid required field.');
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || !spec || typeof spec !== 'object') throw bad('This tool supplied an unsupported field.');
    if (secret.test(key) || spec.format === 'password') throw bad('Complete secrets and credentials through the tool’s own secure authorization flow.');
    if (!['string', 'integer', 'number', 'boolean', 'array'].includes(spec.type)) throw bad('This tool’s form contains a field Pocket Dev cannot display.');
    const allowed = ['type', 'title', 'description', 'default', ...(spec.type === 'string' ? ['enum', 'enumNames', 'oneOf', 'anyOf', 'minLength', 'maxLength', 'format'] : spec.type === 'array' ? ['items', 'minItems', 'maxItems', 'uniqueItems'] : spec.type === 'number' || spec.type === 'integer' ? ['minimum', 'maximum'] : [])];
    if (Object.keys(spec).some((name) => !allowed.includes(name))) throw bad('This tool requires a field constraint Pocket Dev cannot validate. Complete it in the native client.');
    if (spec.format && !['email', 'uri', 'date', 'date-time'].includes(spec.format)) throw bad('Complete this field through the tool’s native client.');
    if (spec.type === 'array' && (!spec.items || (spec.items.type && spec.items.type !== 'string') || Object.keys(spec.items).some((name) => !['type', 'enum'].includes(name)))) throw bad('Only string multi-select lists are supported in tool forms.');
    for (const name of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum']) if (spec[name] != null && (typeof spec[name] !== 'number' || !Number.isFinite(spec[name]))) throw bad('The tool supplied an invalid field constraint.');
    const options = [];
    const enumeration = spec.type === 'array' ? spec.items?.enum : spec.enum;
    const titled = spec.type === 'string' ? spec.oneOf || spec.anyOf : null;
    if (spec.type === 'boolean') options.push({ label: 'Yes', value: true }, { label: 'No', value: false });
    else if (enumeration) {
      if (!Array.isArray(enumeration) || !enumeration.length || enumeration.length > 100 || enumeration.some((item) => typeof item !== 'string' || item.length > 500)) throw bad('This tool supplied an unsupported selection.');
      options.push(...enumeration.map((value) => ({ label: value, value })));
    } else if (titled) {
      if (!Array.isArray(titled) || titled.length > 100 || titled.some((item) => typeof item.const !== 'string' || typeof item.title !== 'string')) throw bad('This tool supplied an unsupported selection.');
      options.push(...titled.map((item) => ({ label: `${item.title} (${item.const})`, value: item.const })));
    } else if (spec.type === 'array') throw bad('Only multi-select lists are supported in tool forms.');
    fields.push({ key, spec, required: required.has(key), options });
  }
  if (!fields.length) return { kind: 'authorization', title: params.message || 'Continue with this MCP tool?', detail: 'The tool requests your confirmation.' };
  const questions = fields.map(({ key, spec, required, options }) => ({ id: key, header: spec.title || key,
    question: [params.message, spec.description || spec.title || key, required ? 'Required' : 'Optional'].filter(Boolean).join('\n'),
    options: options.map(({ label }) => ({ label, description: '' })), multiSelect: spec.type === 'array', allowOther: !options.length }));
  return { kind: 'form', fields, questions };
}
export function mcpInputContent(plan, answers) {
  const content = {};
  for (const { key, spec, required, options } of plan.fields) {
    const given = answers?.[key];
    if (!Array.isArray(given) || !given.length) { if (required) throw bad(`${spec.title || key} is required.`); continue; }
    let value;
    if (options.length) {
      const selected = given.map((text) => { const option = options.find((item) => item.label === text); if (!option) throw bad(`Choose a listed option for ${spec.title || key}.`); return option.value; });
      if (spec.type === 'array') value = [...new Set(selected)];
      else { if (selected.length !== 1) throw bad(`Choose one option for ${spec.title || key}.`); value = selected[0]; }
    } else if (spec.type === 'number' || spec.type === 'integer') {
      if (given.length !== 1 || !given[0].trim()) throw bad(`Enter one number for ${spec.title || key}.`);
      value = Number(given[0]);
      if (!Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value))) throw bad(`Enter a valid ${spec.type} for ${spec.title || key}.`);
      if ((spec.minimum != null && value < spec.minimum) || (spec.maximum != null && value > spec.maximum)) throw bad(`${spec.title || key} is outside the allowed range.`);
    } else {
      if (given.length !== 1) throw bad(`Enter one value for ${spec.title || key}.`);
      value = given[0];
      if (spec.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw bad(`${spec.title || key} needs an email address.`);
      if (spec.format === 'uri') { try { new URL(value); } catch { throw bad(`${spec.title || key} needs a valid address.`); } }
      if (spec.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw bad(`${spec.title || key} needs a valid date.`);
      if (spec.format === 'date-time' && (!value.includes('T') || !Number.isFinite(Date.parse(value)))) throw bad(`${spec.title || key} needs a valid date and time.`);
      if ((spec.minLength != null && value.length < spec.minLength) || (spec.maxLength != null && value.length > spec.maxLength)) throw bad(`${spec.title || key} has an invalid length.`);
    }
    if (Array.isArray(value) && ((spec.minItems != null && value.length < spec.minItems) || (spec.maxItems != null && value.length > spec.maxItems))) throw bad(`${spec.title || key} has an invalid number of selections.`);
    content[key] = value;
  }
  return content;
}
export async function requestMcpInput(chat, params) {
  let plan;
  try { plan = mcpInputPlan(params); }
  catch (error) { chat.emit({ type: 'status', text: error.message }); return { action: 'cancel', content: null }; }
  if (plan.kind === 'authorization') {
    const answer = await chat.ask({ type: 'permission-request', kind: 'tool', title: plan.title, detail: plan.detail,
      options: [{ id: 'allow', label: 'Continue' }, { id: 'deny', label: 'Decline' }] });
    return { action: answer.cancelled ? 'cancel' : answer.decision === 'allow' ? 'accept' : 'decline', content: answer.decision === 'allow' && params.mode !== 'url' ? {} : null };
  }
  let error = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await chat.ask({ type: 'question', questions: plan.questions.map((question) => ({ ...question, question: error ? `${error}\n\n${question.question}` : question.question })) });
    if (answer.cancelled) return { action: 'cancel', content: null };
    try { return { action: 'accept', content: mcpInputContent(plan, answer.answers) }; }
    catch (failure) { error = failure.message; }
  }
  chat.emit({ type: 'status', text: `The tool form was cancelled: ${error}` });
  return { action: 'cancel', content: null };
}
