const fs=require("fs");const dir="/home/user/github_assignment/nutrition_vocab";
let src=fs.readFileSync(dir+"/words.js","utf8");
for(const f of fs.readdirSync(dir+"/vocab").sort()) src+="\n"+fs.readFileSync(dir+"/vocab/"+f,"utf8");
eval(src+";global.V=VOCAB");
const out=[];for(const c of V)for(const g of c.groups)for(const w of g.words)out.push(w);
fs.writeFileSync("/home/user/tts/words.json",JSON.stringify(out));console.log(out.length);
