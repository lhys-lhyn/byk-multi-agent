/**
 * 峰谷判定（北京时间口径）。
 *
 * 与用户现有脚本完全同源，读取自（严禁修改）：
 *   C:\Users\lhyn6\AppData\Local\DSHModelSwitcher\switch-dsh-model.ps1
 * 对应函数 Test-PeakTime / Get-NextPeakChange，常量 PEAK_HOURS /
 * WeekendValleyFromSec / HolidayValleyFromSec / HolidayValley。
 *
 * 规则：
 *   - 高峰：工作日 09:00-12:00、14:00-18:00（北京时间，左闭右开）
 *   - 谷价：其余全部时段；2026-08-23 起周末全天谷价；2026-09-19 起法定节假日全天谷价
 *   - 调休上班日全部落在周末，按「周末也谷价」天然正确，无需单列
 *
 * 每年的放假安排由国务院在头一年 11 月公布，之后必须补 holidays。
 */

/** 高峰小时区间（北京时间的整点，左闭右开）。 */
export const PEAK_HOURS = [[9, 12], [14, 18]];

/** 生效分界：北京时间 2026-08-23 00:00（= UTC 2026-08-22 16:00）。 */
export const WEEKEND_VALLEY_FROM_SEC = Date.UTC(2026, 7, 22, 16, 0, 0) / 1000;

/** 生效分界：北京时间 2026-09-19 00:00（= UTC 2026-09-18 16:00）。 */
export const HOLIDAY_VALLEY_FROM_SEC = Date.UTC(2026, 8, 18, 16, 0, 0) / 1000;

/** 法定节假日（只列放假日）。依据国办发明电〔2025〕7 号。 */
export const HOLIDAY_VALLEY = [
  "2026-01-01", "2026-01-02", "2026-01-03",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
  "2026-10-05", "2026-10-06", "2026-10-07",
];

const BJ_OFFSET_MS = 8 * 3600 * 1000;
const BJ_OFFSET_SEC = 8 * 3600;

/** epoch 秒 -> 北京时间的 Date（用 getUTC* 读出来就是北京时间）。 */
function beijingDate(timeSec) {
  return new Date(timeSec * 1000 + BJ_OFFSET_MS);
}

/** epoch 秒 -> 北京时间的 yyyy-MM-dd。 */
export function beijingDay(timeSec) {
  return beijingDate(timeSec).toISOString().slice(0, 10);
}

/** epoch 秒 -> 北京时间的 HH:mm。 */
export function beijingClock(timeSec) {
  return beijingDate(timeSec).toISOString().slice(11, 16);
}

function normOptions(options) {
  const o = options || {};
  return {
    peakHours: o.peakHours || PEAK_HOURS,
    weekendValleyFromSec: o.weekendValleyFromSec === undefined ? WEEKEND_VALLEY_FROM_SEC : o.weekendValleyFromSec,
    holidayValleyFromSec: o.holidayValleyFromSec === undefined ? HOLIDAY_VALLEY_FROM_SEC : o.holidayValleyFromSec,
    holidays: o.holidays || HOLIDAY_VALLEY,
  };
}

/** 该时刻是否高峰（与脚本 Test-PeakTime 同源）。 */
export function isPeakTime(timeSec, options) {
  const o = normOptions(options);
  const bj = beijingDate(timeSec);

  if (timeSec >= o.weekendValleyFromSec) {
    const dow = bj.getUTCDay(); // 0 = 周日, 6 = 周六
    if (dow === 0 || dow === 6) return false;
  }
  if (timeSec >= o.holidayValleyFromSec && o.holidays.includes(beijingDay(timeSec))) {
    return false;
  }

  const hour = bj.getUTCHours();
  for (const [start, end] of o.peakHours) {
    if (hour >= start && hour < end) return true;
  }
  return false;
}

/** 下一次峰谷切换时刻（epoch 秒，无则 null）。与脚本 Get-NextPeakChange 同源。 */
export function nextPeakChange(timeSec, options) {
  const o = normOptions(options);
  const current = isPeakTime(timeSec, o);
  const day0 = Math.floor((timeSec + BJ_OFFSET_SEC) / 86400) * 86400;
  for (let d = 0; d <= 12; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = day0 + d * 86400 + edge * 3600 - BJ_OFFSET_SEC;
      if (cand <= timeSec + 1) continue;
      if (isPeakTime(cand, o) !== current) return cand;
    }
  }
  return null;
}

/** 给人和模型看的一句话。 */
export function describePhase(timeSec, options) {
  const peak = isPeakTime(timeSec, options);
  const next = nextPeakChange(timeSec, options);
  return {
    peak,
    phase: peak ? "peak" : "off-peak",
    label: peak ? "高峰 PEAK" : "低谷 OFF-PEAK",
    now: beijingDay(timeSec) + " " + beijingClock(timeSec),
    nextChange: next === null ? null : beijingDay(next) + " " + beijingClock(next),
  };
}
