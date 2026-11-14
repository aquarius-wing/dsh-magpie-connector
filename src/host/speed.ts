import type { CatalogModel } from './catalog.js'
function validateSession(session:unknown):asserts session is string {
 if (typeof session!=='string' || !session || session.length>256) throw new Error('Invalid session')
}
/** One account-window reading the gateway echoed on a chat response (Anthropic unified rate-limit headers). */
export interface ServedWindow { reset: number; used?: number }
/** What the last chat response of a session said about the account that served it. */
export interface Served { provider?: string; fiveHour?: ServedWindow; weekly?: ServedWindow }
const MAX_SERVED = 200
const readWindow = (headers: Headers, name: string): ServedWindow | undefined => {
  const reset = Number(headers.get(`anthropic-ratelimit-unified-${name}-reset`))
  if (!Number.isFinite(reset) || reset <= 0) return undefined
  const used = Number(headers.get(`anthropic-ratelimit-unified-${name}-utilization`))
  return { reset, ...(headers.get(`anthropic-ratelimit-unified-${name}-utilization`) !== null && Number.isFinite(used) ? { used } : {}) }
}
/** Pure: the account facts of a response, or undefined when it carries none. */
export function parseServed(headers: Headers): Served | undefined {
  const provider = headers.get('x-magpie-provider') ?? undefined
  const fiveHour = readWindow(headers, '5h'), weekly = readWindow(headers, '7d')
  if (!fiveHour && !weekly) return undefined
  return { ...(provider ? { provider } : {}), ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) }
}

export class SpeedController {
 private readonly served=new Map<string,Served>()
 /** Remember the newest account facts for a session (bounded, oldest dropped). */
 recordServed(session:string,headers:Headers):void {
  const served=parseServed(headers)
  if(!served) return
  this.served.delete(session); this.served.set(session,served)
  if(this.served.size>MAX_SERVED) this.served.delete(this.served.keys().next().value as string)
 }
 private readonly fast=new Set<string>()
 get(session:unknown,catalog:CatalogModel[]=[]) {
  validateSession(session)
  return {tier:this.fast.has(session)?'fast':'standard',...(this.served.has(session)?{served:this.served.get(session)}:{}),fastModels:catalog.filter(m=>m.serviceTiers.includes('priority')).map(m=>m.info.id)}
 }
 set(session:unknown,tier:unknown):void {
  validateSession(session)
  if(tier!=='standard' && tier!=='fast') throw new Error('Invalid tier')
  if(tier==='fast') this.fast.add(session); else this.fast.delete(session)
 }
 /** Call at stream time with prepareCall's captured model capabilities. */
 priority(session:string|undefined,model:CatalogModel):'priority'|undefined {
  return session!==undefined && this.fast.has(session) && model.serviceTiers.includes('priority')?'priority':undefined
 }
}
