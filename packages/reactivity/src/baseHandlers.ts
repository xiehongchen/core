import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import {
  pauseScheduling,
  pauseTracking,
  resetScheduling,
  resetTracking,
} from './effect'
import { ITERATE_KEY, track, trigger } from './reactiveEffect'
import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol),
)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

function createArrayInstrumentations() {
  // Record，这个是ES6规格将键值对的数据结构称为Record
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // 处理身份敏感的数组方法
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    // 首先需要对includes、indexOf、lastIndexOf方法进行重载
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 将代理对象转换成原始对象
      const arr = toRaw(this) as any
      // 遍历数组并调用 track 方法，为每个元素添加依赖跟踪。
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      // 使用原始数组和原始参数调用方法
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        // 如果第一次调用返回 -1 或 false（表示未找到），则使用原始值再次调用方法
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  // 处理长度改变的数组方法
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    // 对 push, pop, shift, unshift, splice 方法进行重载
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 调用 pauseTracking 暂停依赖跟踪
      pauseTracking()
      // 调用 pauseScheduling 暂停调度
      pauseScheduling()
      // 使用原始数组和原始参数调用方法
      const res = (toRaw(this) as any)[key].apply(this, args)
      // 调用 resetScheduling 和 resetTracking 恢复调度和依赖跟踪
      resetScheduling()
      resetTracking()
      return res
    }
  })
  /**
   * 先暂停依赖跟踪和调度更新，是为了避免在这些操作期间引发不必要的依赖收集和可能的无限循环
   */
  return instrumentations
}

function hasOwnProperty(this: object, key: unknown) {
  // #10455 hasOwnProperty may be called with non-string values
  if (!isSymbol(key)) key = String(key)
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key as string)
}

// 基础响应式处理类
class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    // 默认不是只读、浅层次的
    protected readonly _isReadonly = false,
    protected readonly _isShallow = false,
  ) {}

  // get 拦截器，用于拦截对象属性的读取操作
  get(target: Target, key: string | symbol, receiver: object) {
    const isReadonly = this._isReadonly,
      isShallow = this._isShallow
    // 处理各种特殊的标志属性
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return isShallow
    } else if (key === ReactiveFlags.RAW) {
      if (
        receiver ===
          (isReadonly
            ? isShallow
              ? shallowReadonlyMap
              : readonlyMap
            : isShallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        // receiver is not the reactive proxy, but has the same prototype
        // 接收器不是被动代理，而是具有相同的原型
        // this means the reciever is a user proxy of the reactive proxy
        // 这意味着接收器是一个响应式代理的用户代理
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        return target
      }
      // early return undefined
      // 返回undifined
      return
    }
    // 如果源数据是数组
    const targetIsArray = isArray(target)

    if (!isReadonly) {
      // 是原生属性
      if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
        // 添加依赖追踪和调度更新
        return Reflect.get(arrayInstrumentations, key, receiver)
      }
      // 获取原生属性
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    // 通过 Reflect 获取目标对象的属性值
    const res = Reflect.get(target, key, receiver)

    // 如果 key 是 Symbol 类型且是内置 Symbol 或者是不可追踪的 key，直接返回
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 如果不是只读的，进行依赖追踪
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 如果是浅层代理，直接返回属性值
    if (isShallow) {
      return res
    }

    // 如果属性值是 ref 类型，进行解包，数组且 key 是整数时跳过解包
    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    // 如果属性值是对象，将其转换为代理对象，避免循环依赖问题
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

// 处理响应式的程序
class MutableReactiveHandler extends BaseReactiveHandler {
  // 默认深层次
  constructor(isShallow = false) {
    super(false, isShallow)
  }

  // set 方法拦截器，用于处理设置属性值的操作
  set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    // 获取旧的属性值

    let oldValue = (target as any)[key]
    // 深层次处理
    if (!this._isShallow) {
      // 旧值是否是只读
      const isOldValueReadonly = isReadonly(oldValue)
       // 如果新值和旧值都不是浅层代理或只读，获取它们的原始值
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      // 如果目标不是数组，且旧值是 Ref 类型，新值不是 Ref 类型
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        // 如果旧值是只读，返回 false
        if (isOldValueReadonly) {
          return false
        } else {
          // 否则更新旧值的 value 属性
          oldValue.value = value
          return true
        }
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
      // 在浅层模式下，无论对象是否响应式，直接设置对象
    }

    // 检查目标对象中是否已存在该属性
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    // 使用 Reflect 设置属性值
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    // 如果目标对象是原始对象的原型链上层对象，不触发响应
    if (target === toRaw(receiver)) {
      // 如果之前没有该属性，触发 ADD 操作
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 如果值发生了改变，触发 SET 操作
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  // deleteProperty 方法拦截器，用于处理删除属性的操作
  deleteProperty(target: object, key: string | symbol): boolean {
    // 检查目标对象中是否有该属性
    const hadKey = hasOwn(target, key)
    // 获取旧的属性值
    const oldValue = (target as any)[key]
    // 使用 Reflect 删除属性
    const result = Reflect.deleteProperty(target, key)
    // 如果删除成功且之前有该属性，触发 DELETE 操作
    if (result && hadKey) {
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }

  // has 方法拦截器，用于处理 in 操作符
  has(target: object, key: string | symbol): boolean {
    // 使用 Reflect 检查属性是否存在
    const result = Reflect.has(target, key)
    // 如果 key 不是 Symbol 或不是内建的 Symbol，进行依赖收集
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }

  // ownKeys 方法拦截器，用于处理 Object.keys 和 for...in 循环
  ownKeys(target: object): (string | symbol)[] {
    // 进行迭代依赖收集
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY,
    )
    // 使用 Reflect 获取对象的所有属性键
    return Reflect.ownKeys(target)
  }
}

class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(true, isShallow)
  }

  set(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

export const mutableHandlers: ProxyHandler<object> =
  /*#__PURE__*/ new MutableReactiveHandler()

export const readonlyHandlers: ProxyHandler<object> =
  /*#__PURE__*/ new ReadonlyReactiveHandler()

export const shallowReactiveHandlers = /*#__PURE__*/ new MutableReactiveHandler(
  true,
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers =
  /*#__PURE__*/ new ReadonlyReactiveHandler(true)
