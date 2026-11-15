// 下滑触底才翻页；忽略横向滚动，并等待本次加载结束。
export function bindAutoPage(element, canAdvance, advance) {
  let previousTop = element.scrollTop;
  let pending = false;
  const onScroll = async () => {
    const top = element.scrollTop;
    const downward = top > previousTop;
    previousTop = top;
    if (!downward || pending || !canAdvance() || element.scrollHeight <= element.clientHeight ||
        element.scrollHeight - top - element.clientHeight > 12) return;
    pending = true;
    try { await advance(); }
    finally { previousTop = element.scrollTop; pending = false; }
  };
  element.addEventListener('scroll', onScroll, { passive: true });
  return () => element.removeEventListener('scroll', onScroll);
}
