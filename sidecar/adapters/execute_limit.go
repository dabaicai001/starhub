package adapters

// SQL 执行(db.*.execute)对未显式带 LIMIT 的 SELECT 强制追加的行数上限。
// 上限存在的意义是防止一次执行把超大结果集整体拉进内存;UI 的 SQL 编辑器
// 按用户选择的行数上限传 maxRows,未传(模型执行 / 旧调用方)时用默认值。
const (
	// DefaultExecuteMaxRows 未显式传 maxRows 时的默认行数上限。
	DefaultExecuteMaxRows = 1000
	// MaxExecuteMaxRows maxRows 的硬上限,超过一律夹到此处。
	MaxExecuteMaxRows = 100000
)

// ClampExecuteMaxRows 归一化 maxRows:<=0(未传/非法)取默认值,超过硬上限夹到上限。
// @param maxRows 调用方请求的行数上限。
// @returns 生效的行数上限(恒为正且不超过 MaxExecuteMaxRows)。
func ClampExecuteMaxRows(maxRows int) int {
	if maxRows <= 0 {
		return DefaultExecuteMaxRows
	}
	if maxRows > MaxExecuteMaxRows {
		return MaxExecuteMaxRows
	}
	return maxRows
}
