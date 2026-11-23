const zh = {
  openingBrowser: '正在打开浏览器…',
  browserAddressUnavailable: '无法获取浏览器可用的工作台地址。',
  openInWorkbench: (name: string) => `在工作台中打开 ${name}`,
  browserOpenFailed: (error: string) => `打开浏览器失败：${error}`,
  workbenchOpenFailed: (error: string) => `打开工作台失败：${error}`,
  copyFailed: '复制连接信息失败，请重试。',
  loadingWorkbench: '正在加载工作台…',
  connecting: '正在连接…',
  workbenchLoadFailed: '工作台加载失败',
  missingAsset: (id: string) => `未找到资产 ${id}。`,
  noAssetParameter: '缺少资产参数。',
  unsupportedAsset: (id: string) => `资产 ${id} 的类型暂不支持工作台。`,
  retry: '重试',
  deletingConnection: '删除中…',
  savingConnection: '保存中…',
  creatingConnection: '创建中…',
  submittingCode: '正在提交验证码…',
  codeSubmissionFailed: (error: string) => `验证码提交失败：${error}`,
}

const en: typeof zh = {
  openingBrowser: 'Opening browser…',
  browserAddressUnavailable: 'Could not get a workbench address for the browser.',
  openInWorkbench: name => `Open ${name} in the workbench`,
  browserOpenFailed: error => `Could not open the browser: ${error}`,
  workbenchOpenFailed: error => `Could not open the workbench: ${error}`,
  copyFailed: 'Could not copy connection details. Try again.',
  loadingWorkbench: 'Loading workbench…',
  connecting: 'Connecting…',
  workbenchLoadFailed: 'Could not load the workbench',
  missingAsset: id => `Asset ${id} was not found.`,
  noAssetParameter: 'No asset was specified.',
  unsupportedAsset: id => `The workbench does not support asset ${id}.`,
  retry: 'Retry',
  deletingConnection: 'Deleting…',
  savingConnection: 'Saving…',
  creatingConnection: 'Creating…',
  submittingCode: 'Submitting verification code…',
  codeSubmissionFailed: error => `Could not submit the verification code: ${error}`,
}

/** UI feedback follows the language of the host or workbench document. */
export function interactionMessages(): typeof zh {
  return typeof document !== 'undefined' && /^en\b/i.test(document.documentElement.lang) ? en : zh
}
