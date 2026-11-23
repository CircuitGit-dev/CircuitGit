// The compatibility document must not statically preload the standalone module graph for Studio.
const params=new URLSearchParams(location.search);
if(params.get('studio')!=='1'||params.get('embed')==='1'){
  await Promise.all([
    import('../vendor/rnl-viewer/inline-startup-1.js'),
    import('../vendor/rnl-viewer/inline-startup-2.js'),
  ]);
  await Promise.all([
    import('../vendor/rnl-viewer/startup.js'),
    import('../vendor/rnl-viewer/main.js'),
    import('../vendor/rnl-viewer/ic-selection-bridge.js'),
  ]);
}
