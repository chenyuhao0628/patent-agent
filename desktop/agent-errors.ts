// Return classifications only: upstream errors can contain credentials or request bodies.
export function classifySessionError(value: unknown): { code: string; message: string } {
 let text='';try{text=JSON.stringify(value ?? '').toLowerCase();}catch{text='unserializable_error';}
 if (/payload_too_large|request.{0,20}too.{0,10}large|http_413|statuscode[\"\s:]+413/.test(text))return {code:'request_size_limit',message:'图文请求超过本地传输容量限制。请减少本次读取页数，或分批读取后继续；日志已记录限制位置。'};
 if (/response_too_large|event_frame_limit|opencode_response_too_large/.test(text))return {code:'response_size_limit',message:'后台返回内容超过本地容量限制。请分批读取材料并导出日志排查。'};
 if (/typevalidationerror|type validation failed|schema.*validation|invalid.*response.*schema/.test(text))return {code:'response_schema',message:'模型返回格式与后台协议不兼容，请导出日志排查接口适配。'};
 if (/http_400|statuscode[\"\s:]+400|invalid_request_error/.test(text))return {code:'invalid_request',message:'模型接口拒绝了请求格式，请导出日志核查协议和图文参数。'};
 if (/terminated|socket.*closed|stream.*(closed|error)|connection.*reset/.test(text))return {code:'connection',message:'模型连接或响应流中断，请检查网络并导出日志后重试。'};
 if (/context.{0,30}(length|window|limit)|too many tokens|prompt.{0,20}(long|large)|context_length_exceeded/.test(text)) return {code:'context_limit',message:'模型上下文超限。已启用自动压缩；若本次仍失败，可清理当前会话后继续，材料和稿件会保留。'};
 if (/401|403|unauthori|authentication|invalid.{0,10}(key|token)/.test(text)) return {code:'authentication',message:'模型认证失败，请检查模型密钥及访问权限。'};
 if (/429|rate.?limit|quota|insufficient.*balance/.test(text)) return {code:'rate_limit',message:'模型额度不足或请求受限，请检查额度并稍后重试。'};
 if (/timeout|timed out|econn|fetch failed|network|502|503|504/.test(text)) return {code:'connection',message:'模型服务连接失败或超时，请检查网络及供应商状态。'};
 if (/max.?tokens|output.{0,20}limit/.test(text)) return {code:'output_limit',message:'模型达到单次输出上限，可以继续任务。'};
 return {code: text.includes('providererror') ? 'ProviderError' : 'session_error',message:'后台会话失败，未获得可识别的错误类型；不能据此判定上下文超限。可重新尝试或清理会话后继续。'};
}
