// using literal strings instead of numbers so that it's easier to inspect
// debugger events

export enum TrackOpTypes {
  GET = 'get',
  HAS = 'has',
  ITERATE = 'iterate',
}

export enum TriggerOpTypes {
  SET = 'set',
  ADD = 'add',
  DELETE = 'delete',
  CLEAR = 'clear',
}

export enum ReactiveFlags {
  SKIP = '__v_skip', // 跳过，不应被转换为响应式对象
  IS_REACTIVE = '__v_isReactive', // 是否响应式
  IS_READONLY = '__v_isReadonly', // 是否只读
  IS_SHALLOW = '__v_isShallow', // 是否浅层
  RAW = '__v_raw',  // 源数据
}

export enum DirtyLevels {
  NotDirty,
  QueryingDirty,
  MaybeDirty_ComputedSideEffect_Origin,
  MaybeDirty_ComputedSideEffect,
  MaybeDirty,
  Dirty,
}
