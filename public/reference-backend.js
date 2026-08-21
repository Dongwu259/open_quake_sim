(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.PhysicsReference=factory();
}(typeof self!=='undefined'?self:this,function(){
  'use strict';
  var tolerances={
    dc3d:{absolute:1e-10,relative:1e-9,unit:'m'},
    moment:{absolute:1e-3,relative:2e-14,unit:'N m'},
    travelTime:{absolute:1e-8,relative:1e-9,unit:'s'},
    jmaFilter:{absolute:1e-8,relative:1e-8,unit:'intensity'},
    responseSpectrum:{absolute:1e-6,relative:1e-7,unit:'gal'},
    nlsweState:{absolute:1e-5,relative:1e-5,unit:'m or m/s'},
    nlsweMass:{absolute:1e-8,relative:2e-5,unit:'fraction'}
  };
  function compare(moduleName,reference,candidate,override){
    var rule=Object.assign({},tolerances[moduleName]||{},override||{}),a=Number(reference),b=Number(candidate);
    var difference=Math.abs(a-b),limit=Math.max(Number(rule.absolute)||0,(Number(rule.relative)||0)*Math.abs(a));
    return{pass:isFinite(a)&&isFinite(b)&&difference<=limit,reference:a,candidate:b,difference:difference,limit:limit,module:moduleName};
  }
  function compareArrays(moduleName,reference,candidate,override){
    if(!reference||!candidate||reference.length!==candidate.length)return{pass:false,reason:'length',module:moduleName};
    var worst=null,failed=0;
    for(var i=0;i<reference.length;i++){
      var result=compare(moduleName,reference[i],candidate[i],override);result.index=i;
      var ratio=result.limit>0?result.difference/result.limit:(result.difference?Infinity:0);
      var worstRatio=worst?(worst.limit>0?worst.difference/worst.limit:(worst.difference?Infinity:0)):-1;
      if(!worst||ratio>worstRatio)worst=result;
      if(!result.pass)failed++;
    }
    return{pass:failed===0,failed:failed,count:reference.length,worst:worst,module:moduleName};
  }
  return{VERSION:'quake-sim-float64-cpu-reference-v1',precision:'IEEE-754 binary64',deterministic:true,
    tolerances:tolerances,compare:compare,compareArrays:compareArrays};
}));
