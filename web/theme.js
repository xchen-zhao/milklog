// Apply before the page paints, including when following the system at night.
(() => {
  let choice = 'system';
  try { const saved=localStorage.getItem('milk-theme'); if(['light','dark','system'].includes(saved))choice=saved; } catch {}
  const media=matchMedia('(prefers-color-scheme: dark)');
  function apply(value=choice) {
    choice=value;
    const dark=choice==='dark'||(choice==='system'&&media.matches);
    document.documentElement.dataset.theme=dark?'dark':'light';
    document.documentElement.dataset.themeChoice=choice;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#1c221e':'#f7f4ee');
  }
  window.setMilkTheme=value=>{if(!['light','dark','system'].includes(value))return;try{localStorage.setItem('milk-theme',value);}catch{}apply(value);};
  media.addEventListener('change',()=>apply());
  apply();
})();
