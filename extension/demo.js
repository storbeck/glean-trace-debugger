// Synthetic data for offline UI verification. Contains no customer data.
export function demoPayload() {
  const origin=1770000000000;
  const span=(id,parent,name,type,start,end,input,output)=>({
    name,attributes:{'span.gle':{
      span_info:{span_name:name,type,execution_status:{code:'OK'},start_end_timestamps:{start_time_millis:String(origin+start),end_time_millis:String(origin+end)}},
      context:{agent_trace:{trace_id:'sample-trace',span_id:id,parent_id:parent}},
      ...(type==='action'?{action:{action_name:name,tool_call_arguments:input,tool_call_result:output}}:{})
    }},input,output
  });
  return {spans:[
    span('1',null,'Portfolio assistant','agent',0,48200,{message:'Which orders need attention this week?'},{summary:'Two orders need attention.'}),
    span('2','1','Workflow.Run','workflow',20,48100),
    span('3','2','Guardrails: input','guardrail',30,70),
    span('4','2','Agent planning loop','agent',90,47600),
    span('5','4','LLM Call: Plan retrieval','llm',100,4100,{messages:[{role:'user',content:'Which orders need attention this week?'}]},{tool_calls:[{name:'search_orders',arguments:{risk_only:true}}]}),
    span('6','4','search_orders','action',4250,24850,{risk_only:true,limit:100},{results:[{order:'DEMO-101',risk:'supplier delay'},{order:'DEMO-102',risk:'active hold'}],has_more:false}),
    span('7','6','MCP gateway','other',4300,24700),
    span('8','7','Query order service','other',4600,24200),
    span('9','4','LLM Call: Review results','llm',25000,28400,{order_count:2},{next_step:'Check related shipment details'}),
    span('10','4','Shipment checks','agent',28600,32800),
    span('11','10','get_shipment · DEMO-101','action',28600,32300,{order:'DEMO-101'},{status:'awaiting supplier'}),
    span('12','10','get_shipment · DEMO-102','action',28700,32800,{order:'DEMO-102'},{status:'on hold'}),
    span('13','4','LLM Call: Compose response','llm',33000,47500,{instructions:'Summarize the two at-risk orders.'},{message:'DEMO-101 is delayed at the supplier. DEMO-102 has an active hold.'}),
    span('14','2','Guardrails: response','guardrail',47700,48000)
  ]};
}
