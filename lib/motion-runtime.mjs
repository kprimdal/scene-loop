// These functions are also serialized into the pinned scene block. No catalog at playback.
export function resolveMotionTime(item, duration, at) {
  const warnings = [];
  let t = item.start;
  if (item.anchor) {
    const r = at(item.anchor, item.start);
    t = r.t; warnings.push(...r.warnings);
  }
  if (!Number.isFinite(t) || t < 0 || t + item.duration > duration + 1e-6) {
    warnings.push(`Cue is outside this scene; kept authored fallback ${item.start} s.`);
    t = item.start;
  }
  return { t, warnings };
}
export function motionTargetsInPage(scene) {
  const root = document.querySelector(`[data-slot="${scene}"] > .scene`);
  if (!root) throw new Error('Motion needs the scene root.');
  const targets = [{ id:'scene',label:'Whole scene',selector:':scope' }];
  const add = (id,label,selector) => {
    const matches = root.querySelectorAll(selector);
    if (matches.length !== 1) return;
    targets.push({id,label:label.slice(0,90),selector});
  };
  add('heading','Heading · '+(root.querySelector('[data-sl-heading]')?.textContent.trim() || ''),'[data-sl-heading]');
  for (const e of root.querySelectorAll('[data-motion-target]')) {
    const name = e.getAttribute('data-motion-target');
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) continue;
    add(`named:${name}`,e.getAttribute('data-motion-label') || `${name} · ${e.textContent.trim()}`,`[data-motion-target="${name}"]`);
  }
  for (const e of root.querySelectorAll('[data-sl-text-item]')) {
    const id = e.getAttribute('data-sl-text-item');
    if (/^text-[a-z0-9-]{1,48}$/.test(id)) add(`text:${id}`,'Text · '+e.textContent.trim(),`[data-sl-text-item="${id}"] > div`);
  }
  return targets.map(t => {
    const e = t.id==='scene'?root:root.querySelector(t.selector), c = getComputedStyle(e);
    let reason = null;
    if (!['DIV','SECTION','ARTICLE','HEADER','FOOTER','MAIN','ASIDE','P','H1','H2','H3','H4','UL','OL','LI','FIGURE','IMG','VIDEO','SPAN','BUTTON'].includes(e.tagName) || !['block','inline-block','flex','inline-flex','grid','inline-grid','flow-root','list-item'].includes(c.display)) reason='Needs a supported visible block, flex or grid box. Ask the agent to mark a suitable existing element.';
    if (c.position==='static' && c.transform==='none' && c.filter==='none' && c.translate==='none' && c.scale==='none' && c.rotate==='none' && c.perspective==='none' && [...e.querySelectorAll('*')].some(n=>getComputedStyle(n).position==='absolute')) reason='Would change the containing box of absolute-positioned content. Choose an existing positioned target or ask the agent to adapt the layout first.';
    if ([...e.querySelectorAll('*')].some(n=>getComputedStyle(n).position==='fixed')) reason='Contains fixed-position content. Animate a smaller named element to keep its layout.';
    return {...t, ...(reason?{reason}:{})};
  });
}
export function installMotion(scene, items, targetsFn, resolveFn) {
  const root = document.querySelector(`[data-slot="${scene}"] > .scene`);
  const cfg = window.__slConfig.scenes.find(s=>s.id===scene);
  const targets = targetsFn(scene);
  window.__motion = window.__motion || [];
  window.__motionErrors = window.__motionErrors || [];
  for (const item of items) {
    try {
      const target = targets.find(t=>t.id===item.target);
      if (!target || target.reason) throw new Error(target?.reason || 'Target missing or duplicated. Restore its marker or remove this motion.');
      const el = target.id==='scene'?root:root.querySelector(target.selector);
      const timing = resolveFn(item,cfg.duration,(spec,fallback)=> {
        const r = __slAnchorCore.at(cfg.words || [],cfg.narrationLead ?? .35,spec,fallback);
        return r;
      });
      for (const warning of timing.warnings) { window.__anchorWarnings.push(`${scene}: ${item.id}: ${warning}`); console.warn(`${scene}: ${item.id}: ${warning}`); }
      const before=getComputedStyle(el), base={filter:before.filter,translate:before.translate,scale:before.scale};
      const anim = el.animate(item.effect.keyframes,{id:`sl-motion-${scene}-${item.id}`,duration:item.duration*1000,delay:timing.t*1000,fill:'both',easing:item.effect.easing,composite:'add'});
      anim.pause();
      // Check that !important rules do not silently defeat the additive effect.
      anim.currentTime=timing.t*1000+item.duration*500;
      const c=getComputedStyle(el);
      if (c.filter===base.filter || (item.effect.id==='rise' && c.translate===base.translate) || (item.effect.id==='pop' && c.scale===base.scale)) {
        anim.cancel(); throw new Error('An important filter/translate/scale rule blocks motion. Remove that rule or choose another target.');
      }
      window.__motion.push({scene,id:item.id,target:item.target,...timing,duration:item.duration});
      anim.currentTime=0;
    } catch(e) { window.__motionErrors.push(`${scene}: ${item.id}: ${e.message}`); console.warn(window.__motionErrors.at(-1)); }
  }
}
