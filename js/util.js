/* util.js — 여러 파일이 같이 쓰는 작은 도구 */

export const $ = s => document.querySelector(s);
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const ease = t => 1 - Math.pow(1 - t, 3);

// 앱 키·마지막 목적지는 이 휴대폰에만 저장한다 (GitHub에 올라가지 않는다)
export const store = {
  get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
  set(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }
};

// 응답이 ms 안에 안 오면 포기한다 (터널·약한 전파에서 무한 대기 방지)
export async function fetchTimeout(url, opt = {}, ms = 15000){
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try{ return await fetch(url, {...opt, signal:ac.signal}); }
  catch(e){ throw e.name === 'AbortError' ? new Error('응답이 너무 늦어요 (' + Math.round(ms/1000) + '초). 전파 상태를 확인해 주세요.') : e; }
  finally{ clearTimeout(t); }
}
