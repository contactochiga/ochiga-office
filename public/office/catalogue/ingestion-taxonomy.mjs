// Batch review uses the existing category/brand registries and governed taxonomy editor.
export function renderBatchTaxonomy(host, preview, ui, apply, refresh) {
  const {el,escapeHtml:e}=ui;
  const groups=preview.taxonomy_groups||[], unresolved=groups.filter(g=>g.unresolved);
  host.innerHTML='';
  if(!groups.length)return;
  const panel=el(`<section class="ing-panel"><h3>Batch category & manufacturer review</h3>
    <p>${groups.filter(g=>g.kind==='category').length} category paths · ${groups.filter(g=>g.kind==='brand').length} manufacturer labels · ${unresolved.length} unresolved groups. One confirmed mapping applies to every matching source value and category context, across all pages.</p>
    <p>Required: active category and explicit review of unmatched manufacturers. Images, supplier information and unapproved price references do not block draft creation. Unknown OEMs stay unassigned.</p>
    <p>Reviewed mappings are saved for your account and reused on future imports. Original cells and all linked evidence remain unchanged. Applying mappings or refreshing clears draft selections and unsaved per-product edits; review mappings first. No products are created by mapping.</p>
    ${unresolved.length>50?'<p>Showing the first 50 unresolved groups. Apply those mappings to reveal the next groups.</p>':''}
    <div class="ing-actions"><a class="cat-btn" href="#/catalogue/taxonomy">${ui.hasPermission('catalogue.publish')?'Manage categories & brands':'View categories & brands'}</a><button type="button" class="cat-btn" data-refresh>Refresh registry & matches</button></div>
    <p>Creating taxonomy requires the existing catalogue.publish permission. No permission is granted here.</p>
    <div data-groups></div><details><summary>${groups.length-unresolved.length} resolved groups (showing up to 50)</summary><div data-resolved></div></details>
    <label><input type="checkbox" data-confirm-mappings> I confirm the selected mappings and unassigned manufacturers for all matching products.</label>
    <button type="button" class="cat-btn" data-apply>Apply selected batch mappings</button></section>`);
  for(const g of [...unresolved.slice(0,50),...groups.filter(g=>!g.unresolved).slice(0,50)]){
    const rows=g.kind==='category'?preview.categories:preview.brands;
    const card=el(`<div class="ing-panel"><strong>${e(g.kind==='category'?'Category':'Manufacturer')} · ${e(g.source)}</strong>${g.context?`<p>Source context: ${e(g.context)}</p>`:''}<p>${g.count} products · ${e(g.match.reason)}</p>
      <p>${e(g.match.suggestions.map(s=>s.name+': '+s.reason).join('; '))}</p>
      <label>Reviewed destination<select data-target><option value="">No change / review later</option>${g.kind==='brand'?'<option value="__unassigned">Keep unassigned — preserve source manufacturer</option>':''}${g.unassigned_only?'':rows.filter(r=>r.status==='active').map(r=>`<option value="${e(r.id)}">${e(r.name)}</option>`).join('')}</select></label>
      ${g.kind==='brand'?'<label>Reason when leaving manufacturer unassigned<input data-reason placeholder="For example: OEM identity has not been verified" maxlength="300"></label>':''}</div>`);
    card._group=g;panel.querySelector(g.unresolved?'[data-groups]':'[data-resolved]').appendChild(card);
  }
  panel.querySelector('[data-refresh]').onclick=refresh;
  panel.querySelector('[data-apply]').onclick=()=>{
    const mappings=[...panel.querySelectorAll('[data-target]')].filter(n=>n.value).map(n=>{
      const card=n.closest('.ing-panel'),g=card._group;
      return {kind:g.kind,source:g.source,context:g.context,revision:g.revision,target_id:n.value==='__unassigned'?null:n.value,reason:card.querySelector('[data-reason]')?.value||''};
    });
    apply({confirm_mappings:panel.querySelector('[data-confirm-mappings]').checked,mappings});
  };
  host.appendChild(panel);
}
