"use strict";
// Reviewed, actor-scoped aliases are append-only audit decisions, never new taxonomy.
const crypto = require('node:crypto');
const C = require('./catalogue');
const { normal, resolveTaxonomy } = require('./ingestion-evidence');
const ACTION = 'catalogue_ingestion_taxonomy_reviewed';
const unknownManufacturer = value => /\b(oem|unknown|unconfirmed|unspecified|tbc|pending|compatible|supports)\b|works with|powered by/i.test(value);
const contextOf = candidate => candidate.source_references.filter(r=>/collection|category path/i.test(r.label)).map(r=>r.value).join(' ');
const keyOf = (kind, source, context = '') => kind + ':' + normal(source) + (kind==='category' && normal(context) ? ':' + normal(context) : '');
function decisions(events) {
  const groups = new Map();
  for (const event of events) for (const [index, item] of (event.metadata?.mappings || []).entries()) {
    if (!['category','brand'].includes(item.kind) || !item.source_key) continue;
    const key = keyOf(item.kind, item.source_key, item.context);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({...item, decision_id: event.id + ':' + index});
  }
  return new Map([...groups].map(([key, rows]) => {
    const replaced = new Set(rows.flatMap(r => r.parents || []));
    const leaves = rows.filter(r => !replaced.has(r.decision_id));
    const revision = crypto.createHash('sha256').update(leaves.map(r => r.decision_id).sort().join('|')).digest('hex');
    return [key, {leaves, revision}];
  }));
}
const EMPTY = crypto.createHash('sha256').update('').digest('hex');
function resolve(value, records, kind, saved, model = '', context = '') {
  const prior = saved.get(keyOf(kind,value,context));
  if (prior) {
    const targets = new Set(prior.leaves.map(r => r.target_id));
    if (targets.size !== 1) return {id:null,status:'ambiguous',reason:'Conflicting reviewed mappings; confirm one batch decision',suggestions:[],revision:prior.revision};
    const target = prior.leaves[0]?.target_id;
    if (target === null && kind === 'brand') return {id:null,status:'reviewed_unassigned',reason:'Staff reviewed: retain source manufacturer without assigning a brand',suggestions:[],revision:prior.revision};
    const active = records.find(r => r.id === target && r.status === 'active');
    if (active && !(kind === 'brand' && unknownManufacturer(value))) return {id:target,status:'matched',reason:'Previously reviewed mapping for your account',suggestions:[{id:target,name:active.name,reason:'Reviewed mapping'}],revision:prior.revision};
    return {id:null,status:'ambiguous',reason:'Reviewed target is no longer active or is not valid; review again',suggestions:[],revision:prior.revision};
  }
  if (kind === 'brand' && unknownManufacturer(value)) return {id:null,status:'unknown',reason:'Unconfirmed OEM or compatibility statement: keep manufacturer unassigned',suggestions:[]};
  return resolveTaxonomy(value, records, kind, model, context);
}
function batchGroups(candidates, saved) {
  const groups = new Map();
  for (const candidate of candidates) for (const kind of ['category','brand']) {
    const source = kind === 'category' ? candidate.category : candidate.manufacturer;
    if (!normal(source)) continue;
    const context = kind==='category' ? contextOf(candidate) : '';
    const key = keyOf(kind, source, context), match = candidate[kind + '_match'];
    if (!groups.has(key)) groups.set(key, {key,kind,source,context,source_values:[],count:0,unresolved:0,match,revision:saved.get(key)?.revision || EMPTY,unassigned_only:kind === 'brand' && unknownManufacturer(source)});
    const g = groups.get(key); g.count++;
    if (!g.source_values.includes(source)) g.source_values.push(source);
    if (!match.id && match.status !== 'reviewed_unassigned') g.unresolved++;
  }
  return [...groups.values()];
}
async function review({cat,extraction,actor,body,audit,documentId,previewId}) {
  if (body?.confirm_mappings !== true || !Array.isArray(body.mappings) || !body.mappings.length || body.mappings.length > 100) throw C.httpError(400,'ingestion_mapping_confirmation_required');
  const saved = decisions(await cat.ingestionTaxonomyDecisions(actor));
  const categories = await cat.listCategories(), brands = await cat.listBrands(), seen = new Set(), mappings = [];
  for (const m of body.mappings) {
    if (!['category','brand'].includes(m.kind) || typeof m.source !== 'string' || m.source.length > 500 || !normal(m.source)) throw C.httpError(400,'ingestion_invalid_taxonomy_mapping');
    if (typeof (m.context||'')!=='string' || (m.context||'').length>2000) throw C.httpError(400,'ingestion_invalid_taxonomy_mapping');
    const context = m.kind==='category' ? m.context||'' : '';
    const key = keyOf(m.kind,m.source,context), prior = saved.get(key);
    if (seen.has(key)) throw C.httpError(400,'ingestion_duplicate_mapping'); seen.add(key);
    if (m.revision !== (prior?.revision || EMPTY)) throw C.httpError(409,'ingestion_mapping_changed');
    if (!extraction.candidates.some(c => normal(m.kind === 'category' ? c.category : c.manufacturer) === normal(m.source) && (m.kind==='brand'||normal(contextOf(c))===normal(context)))) throw C.httpError(400,'ingestion_mapping_source_missing');
    if (m.target_id === null && m.kind === 'brand') {
      if (typeof m.reason !== 'string' || m.reason.trim().length < 8 || m.reason.length > 300) throw C.httpError(400,'ingestion_unassigned_reason_required');
    } else {
      if (m.kind === 'brand' && unknownManufacturer(m.source)) throw C.httpError(400,'ingestion_unknown_manufacturer');
      if (!(m.kind === 'category' ? categories : brands).some(r => r.id === m.target_id && r.status === 'active')) throw C.httpError(400,'ingestion_mapping_target_inactive');
    }
    mappings.push({kind:m.kind,source_key:normal(m.source),context,target_id:m.target_id,reason:m.target_id === null ? m.reason.trim() : 'Staff-confirmed canonical mapping',parents:prior?.leaves.map(r => r.decision_id) || []});
  }
  // A single durable audit append commits the entire reviewed batch; failed writes are not cached.
  const event = await audit(ACTION,'office_document',documentId,{preview:previewId,mappings,scope:'actor'});
  if (!event?.id || event.sync_status === 'schema_pending') throw C.httpError(503,'ingestion_mapping_save_unconfirmed');
}
module.exports = {ACTION,unknownManufacturer,contextOf,keyOf,decisions,resolve,batchGroups,review};
