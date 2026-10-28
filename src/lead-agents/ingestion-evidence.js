"use strict";
// Deterministic suggestions only. These versioned aliases never create taxonomy records.
const normal = v => String(v || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ");
const CATEGORY_ALIASES = Object.freeze({
  "smart-home-automation": ["smart home", "home automation", "smart lighting", "smart switches", "smart plugs", "curtain motors", "plugs", "lighting", "automation and controls"],
  "security-access-control": ["security", "access control", "smart locks", "door locks", "cctv", "security cameras", "video doorbells", "surveillance", "cameras", "intercom", "video entry"],
  "networking-connectivity": ["networking", "network equipment", "routers", "network switches", "wireless access points", "wifi access points", "industrial networking"],
  "sensors-monitoring": ["sensors", "environmental sensors", "monitoring", "smoke detectors", "motion sensors", "water leak sensors", "power and utility metering", "water and utility metering", "building safety and environmental"],
  "control-panels-gateways": ["control panels", "gateways", "smart hubs", "controllers", "hubs and ir", "industrial iot and gateways"],
  "installation-accessories": ["installation accessories", "mounting accessories", "cables", "connectors", "power supplies"],
});
const BRAND_ALIASES = Object.freeze({"tp-link":["tp link","tplink","tp-link omada"],"ubiquiti":["ubiquiti networks"],"hikvision":["hangzhou hikvision"],"dahua":["dahua technology"],"sonoff":["itead sonoff"]});
const FAMILIES = Object.freeze({"unifi":"ubiquiti","omada":"tp-link","tapo":"tp-link"});
function resolveTaxonomy(value, records, kind, model = "", context = "") {
  const active=records.filter(r=>r.status==='active'), n=normal(value);
  const match=(rows,reason,automatic=true)=>({id:rows.length===1&&automatic?rows[0].id:null,status:rows.length===1&&automatic?'matched':'ambiguous',reason,suggestions:rows.map(r=>({id:r.id,name:r.name,reason}))});
  if(n){
    if(kind==='category'&&n==='electrical and power control')return match(active.filter(r=>['control-panels-gateways','installation-accessories'].includes(r.slug)),'Electrical equipment spans existing categories: staff selection required',false);
    if(kind==='category'&&['switches','relays'].includes(n)&&/residential smart home/i.test(context)){
      const rows=active.filter(r=>r.slug==='smart-home-automation');if(rows.length)return match(rows,'Reviewed contextual alias: residential smart-home collection');
    }
    const exact=active.filter(r=>[normal(r.name),normal(r.slug)].includes(n));
    if(exact.length) return match(exact,'Normalized exact registry match');
    if(kind==='category') {
      const segments=String(value).split(/\s*(?:>|\/|→|::)\s*/).map(normal).filter(Boolean);
      // The deepest known path element is preferred; conflicting branches remain explicit.
      for(const segment of segments.reverse()) {
        const candidates=active.filter(r=>[normal(r.name),normal(r.slug),...(CATEGORY_ALIASES[r.slug]||[]).map(normal)].includes(segment));
        if(candidates.length) return match(candidates,`Reviewed category path/alias: ${segment}`);
      }
    } else {
      // Compatibility statements must never identify the manufacturer.
      if(/\b(compatible|works with|powered by|supports)\b/i.test(value)) return {id:null,status:'ambiguous',reason:'Compatibility/provider text is not manufacturer evidence',suggestions:[]};
      const aliases=active.filter(r=>(BRAND_ALIASES[r.slug]||[]).some(a=>normal(a)===n));
      if(aliases.length) return match(aliases,'Reviewed manufacturer alias');
    }
    const tokens=new Set(n.split(' ').filter(t=>t.length>2 && !['and','with','for'].includes(t)));
    const possible=active.filter(r=>normal(r.name).split(' ').filter(t=>tokens.has(t)).length>=2);
    if(possible.length) return match(possible,'Shared taxonomy terms: suggestion requires staff confirmation',false);
  }
  if(kind==='brand') {
    const family=Object.keys(FAMILIES).find(f=>normal(model).split(' ').includes(f));
    const rows=family?active.filter(r=>r.slug===FAMILIES[family]):[];
    if(rows.length) return match(rows,`Model family ${family}: suggestion only; manufacturer must be confirmed`,false);
  }
  return {id:null,status:n?'unknown':'missing',reason:n?'No reviewed registry match':'No source identity provided',suggestions:[]};
}
const SPEC_HEADERS=/^(?:spec(?:ification)?\s*[:.]\s*|voltage\b|power\b|frequency\b|dimensions\b|weight\b|resolution\b|protocol\b|connectivity\b|operating temperature\b|ip rating\b|ports\b|capacity\b|material\b|battery\b)/i;
const UNIT=/^(.+?)\s+(mA|kW|W|V|A|Hz|kHz|MHz|GHz|mm|cm|m|kg|g|°C|%|GB|TB|MP|dB)$/;
function parseSpecifications(cells) {
  const attributes=[], unresolved=[], seen=new Map();
  const add=(key,value,source)=>{
    key=key.trim().replace(/^spec(?:ification)?\s*[:.]\s*/i,'');value=value.trim();if(!key||!value)return;
    let unit='';const inHeader=/^(.*?)\s*\((mA|kW|W|V|A|Hz|kHz|MHz|GHz|mm|cm|m|kg|g|°C|%|GB|TB|MP|dB)\)$/.exec(key), inValue=UNIT.exec(value);
    if(inHeader){key=inHeader[1].trim();unit=inHeader[2];}
    if(inValue && (!unit||unit===inValue[2])){value=inValue[1];unit=inValue[2];}
    if(key.length>80||value.length>400||attributes.length>=100){unresolved.push({source,reason:'Exceeds catalogue attribute limits; original retained'});return;}
    const prior=seen.get(normal(key));
    if(prior){if(prior.value!==value||prior.unit!==unit)unresolved.push({source,reason:`Conflicting ${key}; review before creation`});else prior.provenance.push(source);return;}
    const attribute={key,value,unit,provenance:[source]};seen.set(normal(key),attribute);attributes.push(attribute);
  };
  for(const cell of cells){
    if(!cell.value||/^[=+@]/.test(cell.value))continue;
    if(cell.field==='specifications_json'){
      try {const rows=JSON.parse(cell.value);if(!Array.isArray(rows)||rows.length>100)throw Error();
        for(const row of rows){if(!row||typeof row.key!=='string'||!['string','number'].includes(typeof row.value)||(row.unit!=null&&typeof row.unit!=='string'))throw Error();
          const key=row.key.trim(),value=String(row.value).trim(),unit=row.unit||'';if(!key||!value||key.length>80||value.length>400||unit.length>40)throw Error();
          const prior=seen.get(normal(key));if(prior){if(prior.value!==value||prior.unit!==unit)unresolved.push({source:cell,reason:'Conflicting structured specification '+key});else prior.provenance.push(cell);}else{const attribute={key,value,unit,provenance:[cell]};seen.set(normal(key),attribute);attributes.push(attribute);}
        }
      }catch{unresolved.push({source:cell,reason:'Invalid structured specification JSON; original retained for review'});}
    } else if(cell.field==='specifications'){
      const parts=cell.value.split(/[;\n•|]+/).map(s=>s.trim()).filter(Boolean);
      for(const part of parts){const pair=/^([^:=]{1,80})\s*[:=]\s*(.+)$/.exec(part);if(pair)add(pair[1],pair[2],cell);else {
        const count=/^(\d[\d,.]*)\s+(circuits?|channels?|ports?|fingerprints|transactions)$/i.exec(part);
        const frequency=/^(\d+(?:\.\d+)?)\s*(GHz|MHz|kHz|Hz)\s+(Wi-Fi|IR)$/i.exec(part);
        const electrical=/^(\d+(?:[.\/–-]\d+)?)\s*(VDC|V|A|W|TB|GB|MP|mm|kg)$/i.exec(part);
        if(count)add(count[2],count[1],cell);
        else if(frequency){add(frequency[3]+' frequency',frequency[1]+' '+frequency[2],cell);}
        else if(electrical){const key={VDC:'Supply voltage',V:'Supply voltage',A:'Current',W:'Power',TB:'Capacity',GB:'Capacity',MP:'Resolution',mm:'Dimension',kg:'Weight'}[electrical[2]];if(key)add(key,part,cell);else add('Source specification '+(attributes.length+1),part,cell);}
        else {unresolved.push({source:cell,reason:'Unstructured or qualified specification retained for review'});add(`Source specification ${attributes.length+1}`,part,cell);}
      }}
    } else if(cell.field==='specification'||(cell.field==='source_reference'&&SPEC_HEADERS.test(cell.header))) add(cell.header,cell.value,cell);
  }
  return {attributes,unresolved};
}
function enrichExtraction(extraction,tables){
  for(const c of extraction.candidates){
    c.source_cells=[];
    for(const row of c.source_rows){const mapping=extraction.mappings.find(m=>m.sheet===row.sheet),table=tables.find(t=>t.sheet===row.sheet);
      for(const col of mapping.columns){const raw=table.data[row.row-1]?.[col.column-1];if(raw!=null&&String(raw).trim())c.source_cells.push({...row,column:col.column,cell:`${columnName(col.column)}${row.row}`,header:col.header,field:col.field,value:String(raw).trim()});}
    }
    const parsed=parseSpecifications(c.source_cells);c.specification_evidence=parsed;
    c.specifications=parsed.attributes.map(({key,value,unit})=>({key,value,unit}));
    if(parsed.unresolved.length)c.warnings.push('Specification text or conflicting values require review; original cells preserved.');
  }
  return {...extraction,version:2};
}
function columnName(n){let s='';for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
module.exports={normal,resolveTaxonomy,parseSpecifications,enrichExtraction,CATEGORY_ALIASES,BRAND_ALIASES};
