// Deliberately synthetic reference data. Multiple meaningful alternatives make
// wrong selection observable; these names/IDs are not official classifications.
export const demoCatalog={
  assets:[
    {MainAssetsID:'MA-DEMO-1',MainAssetsName:'Roads and public spaces / 道路与公共空间'},
    {MainAssetsID:'MA-DEMO-LIGHT',MainAssetsName:'Street lighting / 路灯设施'},
    {MainAssetsID:'MA-DEMO-WASTE',MainAssetsName:'Waste containers / 垃圾收集设施'}
  ],
  assetDetails:{
    'MA-DEMO-1':{SubAssetsID:'SA-DEMO-1',SubAssetsName:'Road surface / 道路路面',Unit:1},
    'MA-DEMO-LIGHT':{SubAssetsID:'SA-DEMO-LIGHT',SubAssetsName:'Streetlight pole / 路灯灯杆',Unit:1},
    'MA-DEMO-WASTE':{SubAssetsID:'SA-DEMO-WASTE',SubAssetsName:'Waste container / 垃圾箱',Unit:1}
  },
  classifications:[
    {municipalityID:'004',type:'CRM',main:{ID:'004_MC-1',Name:'Public space maintenance / 公共空间维护'},sub:{ID:'004_MC-1_SC-1',Name:'Road surface / 道路路面'},special:{ID:'004_MC-1_SC-1_SPC-1',Name:'Road surface damage / 路面破损'}},
    {municipalityID:'004',type:'CRM',main:{ID:'004_MC-CLEAN',Name:'Cleanliness and waste / 环境卫生'},sub:{ID:'004_MC-CLEAN_SC-1',Name:'Waste collection / 垃圾收集'},special:{ID:'004_MC-CLEAN_SC-1_SPC-1',Name:'Uncollected waste / 垃圾未清运'}},
    {municipalityID:'004',type:'CRM',main:{ID:'004_MC-LIGHT',Name:'Street lighting / 道路照明'},sub:{ID:'004_MC-LIGHT_SC-1',Name:'Lighting maintenance / 路灯维护'},special:{ID:'004_MC-LIGHT_SC-1_SPC-1',Name:'Streetlight outage / 路灯不亮'}},
    {municipalityID:'004',type:'CRM',main:{ID:'004_MC-VEHICLE',Name:'Abandoned vehicles / 废弃车辆'},sub:{ID:'004_MC-VEHICLE_SC-1',Name:'Vehicle removal / 车辆清理'},special:{ID:'004_MC-VEHICLE_SC-1_SPC-1',Name:'Suspected abandoned vehicle / 疑似废弃车辆'}}
  ]
};
