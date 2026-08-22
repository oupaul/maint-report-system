// 共用的檢查項目狀態 → 顏色/標籤對照表，EJS 畫面與 PdfReportService 都使用同一份，避免兩邊顯示不一致。

module.exports = {
  normal: {
    label: '正常',
    color: '#16A34A',
    bg: '#F0FDF4',
  },
  warning: {
    label: '警告',
    color: '#D97706',
    bg: '#FFFBEB',
  },
  critical: {
    label: '異常',
    color: '#DC2626',
    bg: '#FEF2F2',
  },
};
