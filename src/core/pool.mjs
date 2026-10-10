/**
 * src/core/pool.js — 对象池。
 *
 * 规则依据 .claude/rules/engine-code.md：热路径零分配。
 * 弹道、粒子、伤害数字、AoS 延迟效果每 tick 都在生灭；直接 new 会让 GC
 * 在团战中打出尖峰。所有短生命周期对象都从池里取、用完归还。
 *
 * 池只保证"不释放内存给 GC"，不保证清零：调用方必须在 acquire 后自行赋值全部字段。
 */
export function createPool(factory, reset, initial = 32) {
  const free = [];
  let created = 0;
  for (let i = 0; i < initial; i++) { free.push(factory()); created++; }
  return {
    acquire() {
      const o = free.length ? free.pop() : (created++, factory());
      if (reset) reset(o);
      return o;
    },
    release(o) { free.push(o); },
    /** 观测值，不是判决（CLAUDE.md：脚本/工具只报告观察） */
    stats() { return { created, free: free.length, inUse: created - free.length }; },
    _free: free
  };
}
