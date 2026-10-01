import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceLedger, type EvidenceSource, type ReadObservation } from './agent-evidence.ts';
import { qualityProblem, mergeEvidenceRanges } from '../src/domain/agent-evidence.ts';
const notice:EvidenceSource={id:'notice',name:'通知',hash:'n-hash',role:'当前通知'};
const reference:EvidenceSource={id:'reference',name:'参考',hash:'r-hash',role:'对比文件'};
function observation(source:EvidenceSource,start:number,end:number,total:number,text='实际原文',extra:Partial<ReadObservation>={}):ReadObservation{return {materialId:source.id,hash:source.hash,unit:'line',start,end,total,mode:'text',completeUnits:true,chunks:[{start,end,text}],...extra};}
const citation=(extra:Record<string,unknown>={})=>({id:'c1',materialId:notice.id,hash:notice.hash,unit:'line',start:1,end:1,quote:'实际原文',target:'opinions/o1/basis',...extra});

test('frozen-draft gaps provide a callable read_draft repair, never an invalid material id',()=>{
 const draft={id:'current-draft',name:'当前冻结稿件',hash:'draft-hash',role:'冻结稿件'};
 const ledger=new EvidenceLedger([draft],{formal:true});
 assert.match(qualityProblem(ledger.inspect({}))!,/read_draft\(\)/);
 ledger.observe(draft,observation(draft,1,1,3,'实际原文'));
 const report=ledger.inspect({evidenceCitations:[citation({materialId:draft.id,hash:draft.hash,start:2,end:3})]});
 assert.match(qualityProblem(report)!,/read_draft\(startLine=2, endLine=3\)/);
 assert.doesNotMatch(qualityProblem(report)!,/read_material/);
});

test('coverage merges overlap and only requires known current-notice gaps, not all reference text',()=>{
 const ledger=new EvidenceLedger([notice,reference],{formal:true,noticeCoverage:true});
 ledger.observe(notice,observation(notice,1,1,5));ledger.observe(reference,observation(reference,100,110,2000));
 let report=ledger.inspect({});assert.match(qualityProblem(report)!,/2-5/);assert.equal(report.materials[1].status,'partial');
 ledger.observe(notice,observation(notice,2,3,5));ledger.observe(notice,observation(notice,3,5,5));
 report=ledger.inspect({});assert.equal(qualityProblem(report),undefined);assert.equal(report.materials[0].status,'complete');
 assert.deepEqual(report.materials[0].ranges,[{start:1,end:5}]);assert(report.issues.some(i=>i.code==='REFERENCE_PARTIAL'&&i.severity==='warning'));
 assert.deepEqual(mergeEvidenceRanges([{start:3,end:4},{start:1,end:2},{start:0,end:99}]),[{start:1,end:4}]);
});
test('visual reads cover delivered pages without claiming text matches or blocking OCR',()=>{
 const ledger=new EvidenceLedger([notice],{formal:true,noticeCoverage:true});
 for(const page of [2,1])ledger.observe(notice,observation(notice,page,page,2,'',{unit:'page',mode:'visual',chunks:[]}));
 const report=ledger.inspect({evidenceCitations:[citation({unit:'page',quote:'模型识读的字'})]});
 assert.equal(qualityProblem(report),undefined);assert.equal(report.materials[0].status,'complete');assert.equal(report.citations[0].status,'visual');assert(report.issues.some(i=>i.code==='VISUAL_REVIEW'));
});
test('conversion declarations and legacy reads remain explicitly unverified',()=>{
 const ledger=new EvidenceLedger([notice,reference],{formal:true,noticeCoverage:true});
 ledger.observe(notice,observation(notice,0,0,0,'',{unit:'unknown',mode:'derived',completeUnits:false,chunks:[]}));ledger.observe(reference);
 const report=ledger.inspect({evidenceCitations:[citation()]});
 assert.equal(qualityProblem(report),undefined);assert.equal(report.citations[0].status,'unverified');assert.equal(report.materials[0].status,'unknown');assert(report.issues.some(i=>i.code==='DECLARED_CONVERSION'));
});
test('provided citations reject invented sources, changed versions, wrong ranges and fabricated quotes',()=>{
 const ledger=new EvidenceLedger([notice],{formal:true});ledger.observe(notice,observation(notice,1,2,3,'第一行实际原文\n第二行不相关内容'));
 const cases=[{materialId:'other-case'},{hash:'old-version'},{end:999},{start:3,end:3},{quote:'编造的原文'},{start:2,end:2,quote:'实际原文'}];
 for(const value of cases){const report=ledger.inspect({evidenceCitations:[citation(value)]});assert(qualityProblem(report),JSON.stringify(value));assert.equal(report.citations[0].status,'invalid');}
 const good=ledger.inspect({evidenceCitations:[citation({quote:'第一行 实际原文'})]});assert.equal(good.citations[0].status,'verified');assert.equal(qualityProblem(good),undefined);
});
test('quote matching respects actual page boundaries and mathematical characters',()=>{
 const ledger=new EvidenceLedger([notice],{formal:true});
 ledger.observe(notice,observation(notice,1,2,2,'',{unit:'page',chunks:[{start:1,end:1,text:'第1页 X² = A'},{start:2,end:2,text:'第2页另一原文'}]}));
 assert.equal(ledger.inspect({evidenceCitations:[citation({unit:'page',quote:'X²=A'})]}).citations[0].status,'verified');
 assert.equal(ledger.inspect({evidenceCitations:[citation({unit:'page',quote:'X2=A'})]}).citations[0].status,'invalid');
 assert.equal(ledger.inspect({evidenceCitations:[citation({unit:'page',quote:'另一原文'})]}).citations[0].status,'invalid');
});
test('overlapping line reads support contiguous quotations without duplicate content',()=>{
 const ledger=new EvidenceLedger([notice]);
 ledger.observe(notice,observation(notice,1,2,3,'甲\n乙'));ledger.observe(notice,observation(notice,2,3,3,'乙\n丙'));
 assert.equal(ledger.inspect({evidenceCitations:[citation({end:3,quote:'甲乙丙'})]}).citations[0].status,'verified');
});
test('missing citations and missing opinion mappings warn; invalid supplied mappings request repair',()=>{
 const ledger=new EvidenceLedger([],{formal:true,opinionIds:['o1','o2']});
 assert.equal(qualityProblem(ledger.inspect({})),undefined);
 assert.equal(qualityProblem(ledger.inspect({opinionResponses:[{opinionId:'o1',response:'正文第一节'}]})),undefined);
 assert(qualityProblem(ledger.inspect({opinionResponses:[{opinionId:'unknown',response:'正文'}]})));
 assert(qualityProblem(ledger.inspect({evidenceCitations:'bad'})));
 assert(qualityProblem(ledger.inspect({opinionResponses:[{opinionId:'o1',response:'正文',citationIds:['missing']}]})));
});
test('partial units never become complete coverage and unknown totals never claim full reading',()=>{
 const ledger=new EvidenceLedger([notice],{formal:true,noticeCoverage:true});ledger.observe(notice,observation(notice,1,1,1,'截断半行',{completeUnits:false}));
 assert(qualityProblem(ledger.inspect({})));
 const unknown=new EvidenceLedger([notice],{formal:true,noticeCoverage:true});unknown.observe(notice,observation(notice,1,1,1,'原文',{total:undefined}));assert.equal(qualityProblem(unknown.inspect({})),undefined);assert.equal(unknown.coverage()[0].status,'unknown');
});
