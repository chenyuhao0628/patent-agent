import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWriteResult, BaselandBusinessError } from './baseland-results.ts';
function result(ep:string,code:string,payload:Record<string,unknown>={}){
 try{assertWriteResult(ep,{Result:code,...payload});throw new Error('unexpected success');}catch(e){assert.ok(e instanceof BaselandBusinessError);return e;}
}
test('busy and packaging requirements have scoped actionable messages without automatic writes',()=>{
 const busy=result('SubmitHandFlow','IsPacking');assert.equal(busy.kind,'busy');assert.match(busy.message,/正在打包/);assert.match(busy.message,/刷新回读/);
 const pack=result('SubmitHandFlow','NeedRePackForApplicantChange');assert.equal(pack.kind,'prerequisite');assert.match(pack.message,/申请人信息/);assert.match(pack.message,/打包不等于递交官方/);
 assert.equal(result('StartHand','IsPacking').kind,'unknown');
 assert.match(result('StartHand','Handing').message,/正在启动递交/);
});
test('confirmation and official cancellation cannot become retryable busy states',()=>{
 const confirmation=result('SubmitHandFlow','NeedConfirmForRepack');assert.equal(confirmation.kind,'confirmation');assert.match(confirmation.message,/不会自动确认或打包/);
 const cancel=result('SubmitHandFlow','CannotBackForWaitSend');assert.equal(cancel.kind,'failure');assert.match(cancel.message,/不会自动取消/);
 assert.equal(result('StartHand','NeedConfirmReStart').kind,'confirmation');
});
test('file reasons give corrective steps; missing details do not render placeholders or arbitrary payload',()=>{
 const image=result('DeleteFormFile','ImageNonConformance',{Message:'secret-value',ImageNonConformanceInfo:'<img src=x onerror=alert(1)>'});
 assert.match(image.message,/165mm × 245mm/);assert.match(image.message,/具体附图位置未取得/);assert.doesNotMatch(image.message,/\{0\}|secret-value|<img/);
 assert.match(result('DeleteFormFile','ParagraphEndSpaceOverLong').message,/段落末尾连续空格/);
 const form=result('UpdateFormPatentRequestInfo','NotChecked1');assert.match(form.message,/具体值未取得/);assert.doesNotMatch(form.message,/\{[01]\}/);
 assert.match(form.message,/不能为通过校验自动勾选/);
});
test('missing and unknown results remain uncertain and are never promoted by unrelated endpoint tables',()=>{
 assert.equal(result('SubmitHandFlow','Success2').kind,'unknown');assert.equal(result('ModifyFormInstructionsAndImage','NeedConfirmForRepack').kind,'unknown');
 assert.throws(()=>assertWriteResult('SubmitHandFlow',{FileNo:'synthetic'}),e=>e instanceof BaselandBusinessError&&e.kind==='unknown');
 assert.doesNotThrow(()=>assertWriteResult('StartHand','AlreadyStarted'));assert.throws(()=>assertWriteResult('SubmitHandFlow','AlreadyStarted'));
});
