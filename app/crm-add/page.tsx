export default function CrmAddPage() {
  return <main style={{minHeight:'100vh',padding:40,background:'#f4f1ff',color:'#17142e',fontFamily:'system-ui'}}><form method="post" action="/api/crm-entry" style={{maxWidth:620,margin:'0 auto',padding:28,borderRadius:20,background:'#fff',display:'grid',gap:16,boxShadow:'0 25px 70px #44338822'}}>
    <h1 style={{margin:0}}>Add positive opportunity</h1>
    <input type="hidden" name="clientId" value="0"/>
    <label>Lead name<input name="name" required style={{display:'block',width:'100%',padding:13,marginTop:7}}/></label>
    <label>Email<input name="email" type="email" required style={{display:'block',width:'100%',padding:13,marginTop:7}}/></label>
    <label>Company<input name="company" required style={{display:'block',width:'100%',padding:13,marginTop:7}}/></label>
    <label>Exact campaign<input name="campaign" required style={{display:'block',width:'100%',padding:13,marginTop:7}}/></label>
    <label>Positive reply<textarea name="reply" required style={{display:'block',width:'100%',minHeight:110,padding:13,marginTop:7}}/></label>
    <button type="submit" style={{padding:14,border:0,borderRadius:10,background:'#6746df',color:'#fff',fontWeight:800}}>Save positive opportunity</button>
  </form></main>;
}
