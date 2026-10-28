// Presentation only: the same reviewed mapping payload and governed registry APIs.
export function renderBatchTaxonomy(host, preview, ui, apply, refresh, {kind='category',drafts=new Map(),onReview=()=>{}}={}) {
 const {el,escapeHtml:e}=ui;
 const groups=(preview.taxonomy_groups||[]).filter(g=>g.kind===kind),unresolved=groups.filter(g=>g.unresolved);
 host.innerHTML='';
 if(!groups.length){host.appendChild(el('<p class="ing-empty">No source groups to map. Upload a catalogue to begin.</p>'));return;}
 const shown=[...unresolved.slice(0,50),...groups.filter(g=>!g.unresolved).slice(0,50)];
 const panel=el(`<div class="ing-section-head"><div><h3>${kind==='category'?'Product category mapping':'Brand mapping'}</h3><p>${unresolved.length} unresolved / ${groups.length} groups · one decision applies to matching products.</p></div><div class="ing-actions"><a class="cat-btn" href="#/catalogue/taxonomy">${ui.hasPermission('catalogue.publish')?'Manage taxonomy':'View taxonomy'}</a><button type="button" class="cat-btn" data-refresh>Refresh matches</button></div></div>`);
 host.appendChild(panel);panel.querySelector('[data-refresh]').onclick=refresh;
 const split=el(`<div class="ing-split"><div class="ing-group-list" role="group" aria-label="${kind==='category'?'Category':'Brand'} groups"></div><div class="ing-detail" data-group-details></div></div>`);host.appendChild(split);
 let selected=shown.find(g=>drafts.has(g.key))?.key||shown[0].key;
 const select=key=>{selected=key;split.querySelectorAll('[data-group-key]').forEach(n=>n.setAttribute('aria-pressed',String(n.dataset.groupKey===key)));split.querySelectorAll('[data-detail-key]').forEach(n=>n.hidden=n.dataset.detailKey!==key);};
 for(const g of shown){
  const button=el(`<button type="button" class="ing-group" data-group-key="${e(g.key)}" aria-pressed="false"><span>${e(g.source)}</span><small>${g.count} products · ${g.unresolved?'Needs review':'Resolved'}</small><small data-pending></small></button>`);
  split.querySelector('.ing-group-list').appendChild(button);button.onclick=()=>select(g.key);
  const rows=kind==='category'?preview.categories:preview.brands;
  const card=el(`<section data-detail-key="${e(g.key)}" hidden><h4>${e(g.source)}</h4><p>${e(g.match.reason)}</p>${g.context?`<p class="ing-muted">Source context: ${e(g.context)}</p>`:''}
   ${g.match.suggestions.length?`<p>Suggestions: ${e(g.match.suggestions.map(s=>s.name).join(' · '))}</p>`:''}
   <label>Reviewed destination<select data-target><option value="">No change / review later</option>${kind==='brand'?'<option value="__unassigned">Keep unassigned — preserve source manufacturer</option>':''}${g.unassigned_only?'':rows.filter(r=>r.status==='active').map(r=>`<option value="${e(r.id)}">${e(r.name)}</option>`).join('')}</select></label>
   ${kind==='brand'?'<label>Reason when leaving manufacturer unassigned<input data-reason placeholder="For example: OEM identity has not been verified" maxlength="300"></label><p class="ing-muted">Unknown OEMs remain unassigned. A platform or compatibility claim is not a manufacturer.</p>':''}
   <button type="button" class="cat-btn" data-review-context>Open product review</button></section>`);
  const draft=drafts.get(g.key);if(draft?.revision===g.revision){card.querySelector('[data-target]').value=draft.value;if(card.querySelector('[data-reason]'))card.querySelector('[data-reason]').value=draft.reason||'';}else drafts.delete(g.key);
  const sync=()=>{const value=card.querySelector('[data-target]').value;button.querySelector('[data-pending]').textContent=value?'Mapping selected — not saved':'';if(value)drafts.set(g.key,{revision:g.revision,value,reason:card.querySelector('[data-reason]')?.value||''});else drafts.delete(g.key);};
  card.oninput=sync;card.onchange=sync;sync();card.querySelector('[data-review-context]').onclick=onReview;split.querySelector('[data-group-details]').appendChild(card);
 }
 select(selected);
 const footer=el(`<div class="ing-mapping-footer"><p class="ing-muted">${unresolved.length>50?'First 50 unresolved groups shown; apply to reveal more. ':''}Saved for your account and source context. Applying or refreshing clears draft selections and unsaved product edits. Source evidence is retained.</p><label class="ing-check"><input type="checkbox" data-confirm-mappings> I confirm these mappings for all matching products.</label><button type="button" class="cat-btn" data-apply>Apply selected ${kind==='category'?'category':'brand'} mappings</button><p class="ing-muted">New taxonomy requires existing catalogue.publish permission. Mapping does not create products or approve commercial information.</p></div>`);
 footer.querySelector('[data-apply]').onclick=()=>apply({confirm_mappings:footer.querySelector('[data-confirm-mappings]').checked,mappings:groups.filter(g=>drafts.has(g.key)).map(g=>{const d=drafts.get(g.key);return {kind:g.kind,source:g.source,context:g.context,revision:d.revision,target_id:d.value==='__unassigned'?null:d.value,reason:d.reason};})});host.appendChild(footer);
}
