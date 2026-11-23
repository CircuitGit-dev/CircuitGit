/** Critical host styles are linked in the entry HTML; legacy entries share this loader. */
export function stylesheet(href) {
  const url = new URL(href, import.meta.url).href;
  let link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(item => item.href === url);
  if (link?.sheet) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = !!link;
    link ||= document.createElement('link');
    const timeout=setTimeout(()=>fail(),12000);
    const done=()=>{clearTimeout(timeout);resolve();};
    const fail=()=>{clearTimeout(timeout);reject(Error('样式加载失败：'+url));};
    link.addEventListener('load',done,{once:true});
    link.addEventListener('error',fail,{once:true});
    if (!existing) { link.rel='stylesheet'; link.href=url; document.head.append(link); }
  });
}
