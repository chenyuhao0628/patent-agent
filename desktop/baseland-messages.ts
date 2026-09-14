// Verified against saved Baseland JS code/key pairs and Chinese resources, 2026-09-13.
// Source: 0001/接入文档/1-贝思兰德云API/附录/业务码中文对照.tsv. No runtime dependency on that repository.
export const officialMessages:Record<string,Record<string,string>> = {
  "submit": {
    "NotPermission": "您没有操作权限，请刷新后再试",
    "AlreadyFinished": "已经完成",
    "NotStartedFlow": "未启动流程",
    "CannotFoundNextFlow": "找不到下一个流程",
    "CannotFoundBackHistory": "找不到退回的历史记录",
    "CannotFoundBackSelf": "不能退回给自己",
    "FlowUserInvalid": "流程人员已无效，不能提交",
    "NoPassVerifyBeforeCaseHand": "递交前验证信息不通过",
    "NoPassVerifyBeforeSubmit": "提交前验证信息不通过",
    "NotPackSuccess": "数据尚未打包！",
    "IsPacking": "数据正在打包中，不能进行提交操作",
    "NeedRePack": "表单数据有变动，需要重新打包！",
    "NotSendSuccess": "案件还未递交，无法完成",
    "CannotBackForWaitSend": "准备递交官文中，请先取消递交官文",
    "CannotBackForSending": "递交官文中，不能退回流程",
    "CannotBackForSendSuccess": "递交官文成功，不能退回流程",
    "Handing": "数据正在处理中",
    "OtherCountryNoHandFile": "请选择递交文件",
    "CannotBatchSubmit": "下一节点处理人不确定，不能进行批量提交",
    "IsInEntrusting": "正在委托中",
    "DescItemChangeDeclareNeedApplicantApplyType": "申请人递交时，著录项目申报书 - 电子申请用户代码及名称需为申请人",
    "DescItemChangeDeclareNeedAgencyApplyType": "代理机构递交时，著录项目申报书 - 电子申请用户代码及名称需为代理机构",
    "IsSending": "正在递交中",
    "NeedRePackForApplicantChange": "案件申请人信息有变动，请重新打包",
    "NeedRePackForInventorChange": "案件发明人信息有变动，请重新打包",
    "NeedRePackForCaseChange": "案件信息有变动，请重新打包",
    "NeedRepackForFormChanged": "表单数据有变动，请重新打包",
    "NotPack": "数据尚未打包",
    "NeedConfirmForRepack": "表单数据有变动，未重新打包，确认继续提交吗？"
  },
  "start": {
    "AlreadyStarted": "已经启动送件",
    "CannotFoundFlow": "没找到流程",
    "CannotFoundCaseProc": "没找到事项",
    "NotUndertaker": "非办理人不能启动递交流程",
    "NotPendingHand": "处于核稿中、递交中状态，不能启动递交流程",
    "NotReviewDraft": "当前状态为待处理，需进行核稿后再启动递交流程",
    "NotFinishedHand": "送件尚未完成，不能重新启动递交流程",
    "NeedConfirmReStart": "当前前处理事项已经递交官方，是否再次启动递交？",
    "Handing": "正在启动递交中",
    "IsDraftReviewing": "核稿中不能，启动递交流程",
    "Auditing": "核稿中，不能启动递交流程"
  },
  "selectForm": {
    "ExistsForm": "表单已存在",
    "NotExistsForm": "表单不存在"
  },
  "deleteFile": {
    "CaseHandIdNullOrEmpty": "递交流程Id为空",
    "FormCodeNullOrEmpty": "表单代码为空",
    "ExistsForm": "表单已存在",
    "NotExistsForm": "表单不存在",
    "FileNull": "文件为空",
    "UploadTypeNotSupported": "上传类型只支持三合一、五合一",
    "InvalidFileFormat": "文件格式无效，只支持doc\\docx文件",
    "ParagraphEndSpaceOverLong": "段落结尾空格超长",
    "ImageNonConformance": "说明书附图中{0}大小超出165mm x 245mm",
    "VerifyPdfImageError": "校验说明书附图图片错误",
    "OtherProveFileIsPartOfOptionStatement": "该证明文件为意见陈述书内容，请于[ 意见陈述书 ]中进行删除",
    "ProveFileIsPartOfReviewInvalidOpinionStatement": "该证明文件为意见陈述书内容，请于[ 复审无效宣告程序意见陈述书 ]中进行删除",
    "OtherProveFileIsPartOfOptionStatementForNotNormalApply": "该证明文件为意见陈述书内容，请于【意见陈述书(关于非正常申请)】中进行删除"
  },
  "requestForm": {
    "CaseHandIdNullOrEmpty": "递交流程Id为空",
    "FormCodeNullOrEmpty": "表单代码为空",
    "DivisionalCaseNull": "请求书中分案信息未填写",
    "IsPublicAdvanceNull": "发明专利请求书中提前公开栏位未勾选",
    "NotChecked": "案件委案信息中[ 是否延迟审查 ]选择了是，外观设计专利请求书中的延迟审查栏位未勾选",
    "NotChecked1": "案件委案信息中[ 延迟审查期限 ]为{0}年，外观设计专利请求书中的延迟审查栏位勾选为{1}年",
    "InventHasSameDayApply": "本发明专利需同日申请的实用新型专利，请勾选[ 同日申请 ]",
    "UtilityHasSameDayApply": "本实用新型专利需同日申请的发明专利，请勾选[ 同日申请 ]"
  },
  "setting": {
    "ExistSetting": "配置数据已存在",
    "CannotFoundSetting": "找不到配置数据",
    "MustCheckIsUseXmlFormatHand": "加速审查或延迟审查需勾选【使用xml格式递交】"
  }
};
