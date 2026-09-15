// Scope-owned caches: expired entries are removed on access and insertion is bounded.
export class SyncCache<T extends {at:number}> extends Map<string,T> {
  readonly ttl:number;
  readonly limit:number;
  private now:()=>number;
  constructor(ttl:number,limit=2000,now=Date.now){super();this.ttl=ttl;this.limit=limit;this.now=now;}
  prune(){
    const now=this.now();
    for(const [key,value] of this)if(now-value.at>=this.ttl||value.at>now)this.delete(key);
    while(this.size>this.limit)this.delete(this.keys().next().value!);
  }
  override get(key:string){this.prune();return super.get(key);}
  override set(key:string,value:T){
    this.delete(key);super.set(key,value);this.prune();return this;
  }
}
