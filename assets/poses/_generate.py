"""
3D导演台 — 预置姿势库生成脚本 v3 (rotation fixes)
从 T-pose 基准出发，用旋转保持骨长，生成 10 个解剖学合理姿势。
"""
import numpy as np, json, os, math
from PIL import Image, ImageDraw, ImageFont

WORKDIR = os.path.dirname(os.path.abspath(__file__))
PREVIEW_DIR = os.path.join(WORKDIR, "preview")
os.makedirs(PREVIEW_DIR, exist_ok=True)

# ==================== T-POSE DATA ====================
T_POSE = {
    "Nose":[0,1.62,0.05],"Neck":[0,1.45,0],
    "RShoulder":[-0.18,1.45,0],"RElbow":[-0.45,1.45,0],"RWrist":[-0.70,1.45,0],
    "LShoulder":[0.18,1.45,0],"LElbow":[0.45,1.45,0],"LWrist":[0.70,1.45,0],
    "RHip":[-0.10,0.95,0],"RKnee":[-0.11,0.52,0],"RAnkle":[-0.12,0.08,0],
    "LHip":[0.10,0.95,0],"LKnee":[0.11,0.52,0],"LAnkle":[0.12,0.08,0],
    "REye":[-0.03,1.66,0.07],"LEye":[0.03,1.66,0.07],
    "REar":[-0.07,1.64,0.02],"LEar":[0.07,1.64,0.02],
}

BONES = {
    "Nose":"Neck","REye":"Nose","LEye":"Nose","REar":"REye","LEar":"LEye",
    "RShoulder":"Neck","LShoulder":"Neck","RElbow":"RShoulder","LElbow":"LShoulder",
    "RWrist":"RElbow","LWrist":"LElbow","RHip":"Neck","LHip":"Neck",
    "RKnee":"RHip","LKnee":"LHip","RAnkle":"RKnee","LAnkle":"LKnee",
}

JOINT_ORDER = ["Nose","Neck","RShoulder","RElbow","RWrist","LShoulder","LElbow","LWrist",
               "RHip","RKnee","RAnkle","LHip","LKnee","LAnkle","REye","LEye","REar","LEar"]

POSE_META = [
    {"id":"stand","name":"自然站立"},{"id":"walk","name":"行走"},{"id":"run","name":"奔跑"},
    {"id":"sit","name":"坐姿"},{"id":"jump","name":"跳跃"},{"id":"wave","name":"挥手"},
    {"id":"arms_crossed","name":"双手抱胸"},{"id":"punch","name":"出拳"},
    {"id":"kneel","name":"单膝跪地"},{"id":"lie","name":"仰躺"},
]

arr=np.array; la=np.linalg
TPOSE_LENGTHS = {c:float(la.norm(arr(T_POSE[c])-arr(T_POSE[BONES[c]]))) for c in BONES}

def chk(pose,pid,tol=0.05):
    e=[]
    for c in BONES:
        l=float(la.norm(arr(pose[c])-arr(pose[BONES[c]])))
        ref=TPOSE_LENGTHS[c]; er=abs(l-ref)/ref
        if er>tol: e.append(f"  [{pid}] {c}: {l:.4f}/{ref:.4f} err={er*100:.1f}%")
    return e

def rot(v,axis,rad):
    """Rodrigues rotation. Preserves vector length."""
    k=arr(axis,dtype=float); k=k/la.norm(k); v=arr(v,dtype=float)
    c=math.cos(rad); s=math.sin(rad)
    return v*c + np.cross(k,v)*s + k*np.dot(k,v)*(1-c)

def tvec(c): return arr(T_POSE[c])-arr(T_POSE[BONES[c]])
def tlen(c): return TPOSE_LENGTHS[c]

def setd(pose,child,parent,direction):
    """Set child = parent + norm(direction)*bone_length"""
    d=arr(direction,dtype=float)
    pose[child]=(parent+d/la.norm(d)*tlen(child)).tolist()

def head(pose):
    nk=arr(pose["Neck"])
    setd(pose,"Nose",nk,tvec("Nose"))
    no=arr(pose["Nose"])
    setd(pose,"REye",no,tvec("REye")); setd(pose,"LEye",no,tvec("LEye"))
    setd(pose,"REar",arr(pose["REye"]),tvec("REar")); setd(pose,"LEar",arr(pose["LEye"]),tvec("LEar"))

# Helper: create arm pair (R/L) from shoulder positions
def arm_pair(pose, rsh, lsh, r_ua_rot, r_fa_dir, l_ua_rot, l_fa_dir):
    """r_ua_rot/l_ua_rot: lists of (axis, angle_rad) for upper arm rotation calls"""
    rd = tvec("RElbow")
    for ax, ang in r_ua_rot: rd = rot(rd, ax, ang)
    setd(pose, "RElbow", rsh, rd)
    setd(pose, "RWrist", arr(pose["RElbow"]), r_fa_dir)
    ld = tvec("LElbow")
    for ax, ang in l_ua_rot: ld = rot(ld, ax, ang)
    setd(pose, "LElbow", lsh, ld)
    setd(pose, "LWrist", arr(pose["LElbow"]), l_fa_dir)

# ==================== POSES ====================

# CONVENTION:
#   Right arm T-pose vector = (-0.27, 0, 0). +Z rotation (pos angle) = arm goes DOWN.
#   Left arm T-pose vector = (0.27, 0, 0). +Z rotation (neg angle) = arm goes DOWN.
#   Hip direction from neck: (-0.10,-0.50,0). -X rotation (neg angle) = forward tilt.

R = math.radians

# 1. stand — arms hang naturally
def pose_stand():
    p={}; p["Neck"]=[0,1.45,0]; head(p)
    nk=arr(p["Neck"])
    setd(p,"RShoulder",nk,rot(tvec("RShoulder"),[1,0,0],R(-3)))
    setd(p,"LShoulder",nk,rot(tvec("LShoulder"),[1,0,0],R(3)))
    # Right arm: +Z rot for down (R rotates from -X toward -Y)
    arm_pair(p, arr(p["RShoulder"]), arr(p["LShoulder"]),
             [([0,0,1],R(80))], [-0.15,-1,0.25],
             [([0,0,1],R(-80))], [0.15,-1,0.25])
    setd(p,"RHip",nk,tvec("RHip")); setd(p,"LHip",nk,tvec("LHip"))
    setd(p,"RKnee",arr(p["RHip"]),tvec("RKnee")); setd(p,"LKnee",arr(p["LHip"]),tvec("LKnee"))
    setd(p,"RAnkle",arr(p["RKnee"]),tvec("RAnkle")); setd(p,"LAnkle",arr(p["LKnee"]),tvec("LAnkle"))
    return p

# 2. walk — right leg forward, left leg back, arms opposite
def pose_walk():
    p={}; p["Neck"]=[0,1.44,0.05]; head(p)
    nk=arr(p["Neck"])
    setd(p,"RShoulder",nk,tvec("RShoulder")); setd(p,"LShoulder",nk,tvec("LShoulder"))
    # Arms: right back (opposite to right leg forward), left forward
    arm_pair(p, arr(p["RShoulder"]), arr(p["LShoulder"]),
             [([0,0,1],R(60)), ([1,0,0],R(20))], [-0.3,-0.7,0.5],     # right arm back
             [([0,0,1],R(-60)), ([1,0,0],R(-20))], [0.3,-0.6,-0.6])    # left arm forward
    setd(p,"RHip",nk,tvec("RHip")); setd(p,"LHip",nk,tvec("LHip"))
    setd(p,"RKnee",arr(p["RHip"]),rot(tvec("RKnee"),[1,0,0],R(28)))
    setd(p,"RAnkle",arr(p["RKnee"]),rot(tvec("RAnkle"),[1,0,0],R(-22)))
    setd(p,"LKnee",arr(p["LHip"]),rot(tvec("LKnee"),[1,0,0],R(-25)))
    setd(p,"LAnkle",arr(p["LKnee"]),rot(tvec("LAnkle"),[1,0,0],R(18)))
    return p

# 3. run — bigger stride, high knee, big arm swing
def pose_run():
    p={}; p["Neck"]=[0,1.42,0.15]; head(p)
    nk=arr(p["Neck"])
    setd(p,"RShoulder",nk,tvec("RShoulder")); setd(p,"LShoulder",nk,tvec("LShoulder"))
    # Right arm swings forward-up, left arm back
    arm_pair(p, arr(p["RShoulder"]), arr(p["LShoulder"]),
             [([0,0,1],R(115))], [-0.05,0.4,-1.0],               # right arm forward-up
             [([0,0,1],R(-65)), ([1,0,0],R(20))], [-0.1,-0.5,0.7])  # left arm back
    setd(p,"RHip",nk,tvec("RHip")); setd(p,"LHip",nk,tvec("LHip"))
    setd(p,"RKnee",arr(p["RHip"]),rot(tvec("RKnee"),[1,0,0],R(55)))   # knee high
    setd(p,"RAnkle",arr(p["RKnee"]),rot(tvec("RAnkle"),[1,0,0],R(-50)))
    setd(p,"LKnee",arr(p["LHip"]),rot(tvec("LKnee"),[1,0,0],R(-30)))  # leg extended back
    setd(p,"LAnkle",arr(p["LKnee"]),rot(tvec("LAnkle"),[1,0,0],R(28)))
    return p

# 4. sit — thighs horizontal forward, shins vertical down, arms on thighs
def pose_sit():
    p={}; p["Neck"]=[0,0.98,0.25]; head(p)
    nk=arr(p["Neck"])
    setd(p,"RShoulder",nk,tvec("RShoulder")); setd(p,"LShoulder",nk,tvec("LShoulder"))
    # Arms: rest on thighs (forward/down)
    arm_pair(p, arr(p["RShoulder"]), arr(p["LShoulder"]),
             [([0,0,1],R(65)), ([1,0,0],R(-15))], [-0.2,-0.1,0.95],
             [([0,0,1],R(-65)), ([1,0,0],R(15))], [0.2,-0.1,0.95])
    # Hips: below neck, with slight forward lean (-X rotation tilts forward)
    setd(p,"RHip",nk,rot(tvec("RHip"),[1,0,0],R(-25)))
    setd(p,"LHip",nk,rot(tvec("LHip"),[1,0,0],R(-25)))
    # Thighs: horizontal forward (-90 X rotation for forward direction)
    setd(p,"RKnee",arr(p["RHip"]),rot(tvec("RKnee"),[1,0,0],R(-90)))
    setd(p,"LKnee",arr(p["LHip"]),rot(tvec("LKnee"),[1,0,0],R(-90)))
    # Shins: straight down
    setd(p,"RAnkle",arr(p["RKnee"]),[0,-1,0])
    setd(p,"LAnkle",arr(p["LKnee"]),[0,-1,0])
    return p

# 5. jump — lifted ~0.3m, knees bent, arms V-up
def pose_jump():
    p={}; p["Neck"]=[0,1.75,0.02]; head(p)
    nk=arr(p["Neck"])
    setd(p,"RShoulder",nk,rot(tvec("RShoulder"),[1,0,0],R(8)))
    setd(p,"LShoulder",nk,rot(tvec("LShoulder"),[1,0,0],R(-8)))
    # Arms raised in V (past vertical)
    arm_pair(p, arr(p["RShoulder"]), arr(p["LShoulder"]),
             [([0,0,1],R(115))], [0.5,0.6,-0.6],    # right arm up-right
             [([0,0,1],R(-115))], [-0.5,0.6,-0.6])   # left arm up-left
    setd(p,"RHip",nk,tvec("RHip")); setd(p,"LHip",nk,tvec("LHip"))
    setd(p,"RKnee",arr(p["RHip"]),rot(tvec("RKnee"),[1,0,0],R(35)))
    setd(p,"RAnkle",arr(p["RKnee"]),rot(tvec("RAnkle"),[1,0,0],R(-55)))
    setd(p,"LKnee",arr(p["LHip"]),rot(tvec("LKnee"),[1,0,0],R(35)))
    setd(p,"LAnkle",arr(p["LKnee"]),rot(tvec("LAnkle"),[1,0,0],R(-55)))
    return p

# 6. wave — right arm overhead, left at side
def pose_wave():
    p={}; p["Neck"]=[0,1.45,0]; head(p)
    nk=arr(p["Neck"])
    setd(p,"RShoulder",nk,rot(tvec("RShoulder"),[1,0,0],R(5)))
    setd(p,"LShoulder",nk,rot(tvec("LShoulder"),[1,0,0],R(-5)))
    # Right arm: overhead (rotate past 90° to go up)
    arm_pair(p, arr(p["RShoulder"]), arr(p["LShoulder"]),
             [([0,0,1],R(155))], [0.3,0.7,-0.6],         # right overhead
             [([0,0,1],R(-80))], [0.15,-1,0.2])          # left at side
    setd(p,"RHip",nk,tvec("RHip")); setd(p,"LHip",nk,tvec("LHip"))
    setd(p,"RKnee",arr(p["RHip"]),tvec("RKnee")); setd(p,"LKnee",arr(p["LHip"]),tvec("LKnee"))
    setd(p,"RAnkle",arr(p["RKnee"]),tvec("RAnkle")); setd(p,"LAnkle",arr(p["LKnee"]),tvec("LAnkle"))
    return p

# 7. arms_crossed — hands cross at chest
def pose_arms_crossed():
    p={}; p["Neck"]=[0,1.45,0]; head(p)
    nk=arr(p["Neck"])
    setd(p,"RShoulder",nk,tvec("RShoulder")); setd(p,"LShoulder",nk,tvec("LShoulder"))
    arm_pair(p, arr(p["RShoulder"]), arr(p["LShoulder"]),
             [([0,0,1],R(65)), ([1,0,0],R(-20))], [0.8,0.05,0.2],    # right crosses left
             [([0,0,1],R(-65)), ([1,0,0],R(20))], [-0.8,-0.05,0.2])   # left crosses right
    setd(p,"RHip",nk,tvec("RHip")); setd(p,"LHip",nk,tvec("LHip"))
    setd(p,"RKnee",arr(p["RHip"]),tvec("RKnee")); setd(p,"LKnee",arr(p["LHip"]),tvec("LKnee"))
    setd(p,"RAnkle",arr(p["RKnee"]),tvec("RAnkle")); setd(p,"LAnkle",arr(p["LKnee"]),tvec("LAnkle"))
    return p

# 8. punch — right punch forward, left guard, lunge
def pose_punch():
    p={}; p["Neck"]=[0,1.40,0.15]; head(p)
    nk=arr(p["Neck"])
    setd(p,"RShoulder",nk,tvec("RShoulder")); setd(p,"LShoulder",nk,tvec("LShoulder"))
    # Right: punch. Left: guard.
    arm_pair(p, arr(p["RShoulder"]), arr(p["LShoulder"]),
             [([0,0,1],R(90)), ([1,0,0],R(-55))], [0,0,1.0],          # punch forward
             [([0,0,1],R(-75)), ([1,0,0],R(-25))], [-0.25,0.45,0.85]) # guard near chin
    setd(p,"RHip",nk,tvec("RHip")); setd(p,"LHip",nk,tvec("LHip"))
    setd(p,"RKnee",arr(p["RHip"]),rot(tvec("RKnee"),[1,0,0],R(25)))
    setd(p,"RAnkle",arr(p["RKnee"]),rot(tvec("RAnkle"),[1,0,0],R(-20)))
    setd(p,"LKnee",arr(p["LHip"]),rot(tvec("LKnee"),[1,0,0],R(-15)))
    setd(p,"LAnkle",arr(p["LKnee"]),rot(tvec("LAnkle"),[1,0,0],R(12)))
    return p

# 9. kneel — right knee on ground, left knee up
def pose_kneel():
    p={}; p["Neck"]=[0,1.02,0.10]; head(p)
    nk=arr(p["Neck"])
    setd(p,"RShoulder",nk,tvec("RShoulder")); setd(p,"LShoulder",nk,tvec("LShoulder"))
    arm_pair(p, arr(p["RShoulder"]), arr(p["LShoulder"]),
             [([0,0,1],R(80))], [-0.1,-1,0.15],
             [([0,0,1],R(-80))], [0.1,-1,0.15])
    # Right leg: kneeling. Hip is down, knee back, foot back.
    setd(p,"RHip",nk,rot(tvec("RHip"),[1,0,0],R(-30)))
    setd(p,"RKnee",arr(p["RHip"]),rot(tvec("RKnee"),[1,0,0],R(15)))
    setd(p,"RAnkle",arr(p["RKnee"]),[0,0.2,-1.0])  # foot behind, on ground
    # Left leg: foot on ground, knee up (90 deg bend)
    setd(p,"LHip",nk,rot(tvec("LHip"),[1,0,0],R(-15)))
    setd(p,"LKnee",arr(p["LHip"]),rot(tvec("LKnee"),[1,0,0],R(-30)))
    setd(p,"LAnkle",arr(p["LKnee"]),rot(tvec("LAnkle"),[1,0,0],R(28)))
    return p

# 10. lie — body horizontal, face up
def pose_lie():
    p={}
    offset=arr([0,0.10,1.55])
    for j in JOINT_ORDER:
        x,y,z=T_POSE[j]
        p[j]=(arr([x,z,-y])+offset).tolist()
    return p

# ==================== VALIDATION ====================
def validate_all(poses):
    ok=True
    for m in POSE_META:
        pid=m["id"]; errs=chk(poses[pid],pid)
        if errs:
            print(f"[FAIL] {pid} ({m['name']}):")
            for e in errs: print(e); ok=False
        else: print(f"  [OK] {pid} ({m['name']})")
    return ok

# ==================== PREVIEW ====================
def make_preview(pose,out,title):
    X_MIN,X_MAX=-1.0,1.0; Y_MIN,Y_MAX=-0.2,2.0
    M=50; VW,VH=400,700
    
    # Adaptive Z bounds for side view
    all_z=[pose[j][2] for j in JOINT_ORDER]
    z_span=max(all_z)-min(all_z)
    z_mid=(max(all_z)+min(all_z))/2
    if z_span < 0.1: z_span=0.3  # minimum spread
    Z_MIN=z_mid-z_span*0.8; Z_MAX=z_mid+z_span*0.8

    def proj_xy(j):
        x,y,z=pose[j]
        return (int(M+(x-X_MIN)/(X_MAX-X_MIN)*(VW-2*M)),
                int(VH-M-(y-Y_MIN)/(Y_MAX-Y_MIN)*(VH-2*M)))
    def proj_zy(j):
        x,y,z=pose[j]
        return (int(M+(z-Z_MIN)/(Z_MAX-Z_MIN)*(VW-2*M)),
                int(VH-M-(y-Y_MIN)/(Y_MAX-Y_MIN)*(VH-2*M)))

    img=Image.new("RGB",(VW*2,VH),(12,12,24))
    d=ImageDraw.Draw(img)
    try:
        fn=ImageFont.truetype("C:\\Windows\\Fonts\\msyh.ttc",15)
        fs=ImageFont.truetype("C:\\Windows\\Fonts\\msyh.ttc",10)
    except: fn=fs=ImageFont.load_default()

    DB=list(BONES.items())+[("RShoulder","LShoulder"),("RHip","LHip")]
    views=[
        ("XY (Front)",proj_xy,0,(200,240,255),(255,170,70)),
        ("ZY (Side)",proj_zy,VW,(255,220,120),(255,120,50)),
    ]

    for vl,proj,xoff,lc,ptc in views:
        d.text((xoff+6,4),f"{title} - {vl}",fill=(255,255,255),font=fn)
        # Grid
        for i in range(7):
            gy=M+i*(VH-2*M)//6
            d.line([(xoff+M,gy),(xoff+VW-M,gy)],fill=(40,40,55),width=1)
            gx=xoff+M+i*(VW-2*M)//6
            d.line([(gx,M),(gx,VH-M)],fill=(40,40,55),width=1)
        # Ground line (Y=0)
        gy0=proj_xy("RAnkle")[1] if "RAnkle" in pose else M+300
        gy0=int(VH-M-(0-Y_MIN)/(Y_MAX-Y_MIN)*(VH-2*M))
        d.line([(xoff+M,gy0),(xoff+VW-M,gy0)],fill=(60,60,80),width=1)
        
        # Bones: all solid, different colors for L/R in side view
        for ch,pa in DB:
            c,p=proj(ch),proj(pa)
            is_left=vl=="ZY (Side)" and (ch.startswith("L") or pa.startswith("L"))
            if is_left:
                d.line([(xoff+p[0],p[1]),(xoff+c[0],c[1])],fill=(120,180,200),width=3)
            else:
                d.line([(xoff+p[0],p[1]),(xoff+c[0],c[1])],fill=lc,width=4)
        # Joints
        for j in JOINT_ORDER:
            pt=proj(j); r=5 if j=="Neck" else 4
            d.ellipse([xoff+pt[0]-r,pt[1]-r,xoff+pt[0]+r,pt[1]+r],fill=ptc,outline=(0,0,0))
        # Label
        d.text((xoff+VW//2,VH-20),f"{title}",fill=(160,160,190),font=fs,anchor="ms")
    img.save(out); print(f"  {os.path.basename(out)}")

# ==================== MAIN ====================
def main():
    print("="*55); print("  3D Director Pose Generator v3"); print("="*55)
    poses={}
    gens={"stand":pose_stand,"walk":pose_walk,"run":pose_run,"sit":pose_sit,
          "jump":pose_jump,"wave":pose_wave,"arms_crossed":pose_arms_crossed,
          "punch":pose_punch,"kneel":pose_kneel,"lie":pose_lie}
    for m in POSE_META:
        pid=m["id"]
        poses[pid]=gens[pid]()
        assert len(poses[pid])==18,f"{pid}: {len(poses[pid])} joints"
        print(f"  >> {pid} ({m['name']}) 18 joints OK")

    print(f"\n{'='*55}\n  Bone Length Validation (<5%)"); print("="*55)
    ok=validate_all(poses)

    print(f"\n{'='*55}\n  Writing JSON"); print("="*55)
    for m in POSE_META:
        pid=m["id"]
        with open(os.path.join(WORKDIR,f"{pid}.json"),"w",encoding="utf-8") as f:
            json.dump({"id":pid,"name":m["name"],"joints":poses[pid]},f,ensure_ascii=False,indent=2)
        print(f"  {pid}.json")
    idx={"poses":[{"id":m["id"],"name":m["name"],"file":f"{m['id']}.json"} for m in POSE_META]}
    with open(os.path.join(WORKDIR,"index.json"),"w",encoding="utf-8") as f:
        json.dump(idx,f,ensure_ascii=False,indent=2)
    print("  index.json")

    print(f"\n{'='*55}\n  Preview Images"); print("="*55)
    for m in POSE_META:
        make_preview(poses[m["id"]],os.path.join(PREVIEW_DIR,f"{m['id']}.png"),m["id"])

    print(f"\n{'='*55}"); print(f"  Done: 10 poses | bones={'ALL OK' if ok else 'HAS FAILURES!'}")
    print("="*55)
    return ok

if __name__=="__main__":
    exit(0 if main() else 1)
