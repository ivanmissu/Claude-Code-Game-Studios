/**
 * src/core/events.js — 极小事件总线。
 *
 * 模拟产生事件（击杀、拆塔、升级、购买、增益…），渲染与 HUD 消费事件。
 * 关键约束：模拟**不**反向依赖 UI（.claude/rules/gameplay-code.md：gameplay 不得引用 UI），
 * 事件是单向的出口，且每个 tick 结束统一 flush，避免渲染期间状态被改写。
 *
 * 命名遵循 project.yaml → naming.signals: past_tense。
 */
export function createEventBus() {
  const handlers = new Map();
  const queue = [];
  return {
    on(name, fn) {
      let arr = handlers.get(name);
      if (!arr) { arr = []; handlers.set(name, arr); }
      arr.push(fn);
      return () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
    },
    /** 入队，tick 结束时统一派发 */
    emit(name, payload) { queue.push({ name, payload }); },
    /** 立即派发（仅用于 tick 之外的场景，如 UI 主动查询） */
    emitNow(name, payload) {
      const arr = handlers.get(name);
      if (arr) for (let i = 0; i < arr.length; i++) arr[i](payload, name);
    },
    flush() {
      for (let i = 0; i < queue.length; i++) {
        const e = queue[i];
        const arr = handlers.get(e.name);
        if (arr) for (let j = 0; j < arr.length; j++) arr[j](e.payload, e.name);
      }
      queue.length = 0;
    },
    pending() { return queue.length; },
    clear() { queue.length = 0; }
  };
}

/** 事件名常量——集中定义避免拼写漂移（past_tense）。 */
export const EV = Object.freeze({
  UNIT_DIED: 'unit_died',
  HERO_KILLED: 'hero_killed',
  STRUCTURE_DESTROYED: 'structure_destroyed',
  LEVEL_GAINED: 'level_gained',
  ABILITY_RANKED_UP: 'ability_ranked_up',
  ITEM_BOUGHT: 'item_bought',
  ITEM_SOLD: 'item_sold',
  BUFF_GAINED: 'buff_gained',
  BUFF_EXPIRED: 'buff_expired',
  CAMP_CLEARED: 'camp_cleared',
  WAVE_SPAWNED: 'wave_spawned',
  GAME_OVER: 'game_over',
  ABILITY_CAST: 'ability_cast',
  DAMAGE_DEALT: 'damage_dealt'
});
