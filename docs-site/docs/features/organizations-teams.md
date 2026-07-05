---
title: "Organizations & Team Management"
description: "Comprehensive guide to Bike4Mind's enterprise collaboration features including organizations, team management, billing, and permissions"
sidebar_position: 7
tags: [organizations, teams, collaboration, enterprise]
---

# Organizations & Team Management 🏢

Bike4Mind provides sophisticated **enterprise-grade organization and team management** capabilities that enable seamless collaboration, role-based access control, and scalable billing for teams of any size.

## 🎯 **Overview**

Organizations in Bike4Mind are **collaborative workspaces** that allow teams to:
- **Share knowledge and projects** across team members
- **Manage permissions** with granular role-based access control
- **Collaborate on AI sessions** and file processing
- **Track team usage** and billing through integrated subscription management
- **Scale seamlessly** from small teams to large enterprises

---

## 🚀 **Getting Started with Organizations**

### **Creating Your First Organization**

1. **Navigate to Organizations**
   - Go to `/organizations` or click the Organizations link in your navigation
   - Click **"Create Team"** to start a new organization

2. **Choose Your Plan**
   - **Personal Organization** - For individual use with basic sharing
   - **Team Organization** - For collaborative teams with full features

3. **Set Up Your Team**
   - **Organization Name** - Choose a descriptive name for your team
   - **Team Size** - Select the number of seats (minimum 4 seats)
   - **Billing Information** - Configure payment and billing contact

### **Organization Types**

**Personal Organizations:**
- Created automatically for each user
- Basic sharing capabilities
- Individual billing and credit management
- Perfect for personal projects with occasional collaboration

**Team Organizations:**
- Full collaborative features
- Seat-based billing starting at 4 seats
- Advanced permission management
- Enterprise-grade features and controls

---

## 👥 **Team Member Management**

### **Adding Team Members**

1. **Invite by Email**
   - Navigate to your organization's Members tab
   - Click **"Add Members"** 
   - Enter email addresses of team members to invite
   - Set initial permissions (Read, Write, or Share)

2. **Permission Levels**
   - **Read** - View shared content and participate in discussions
   - **Write** - Create and edit content, participate fully
   - **Share** - Manage sharing settings and invite others

3. **Seat Management**
   - Monitor seat usage in the Members tab
   - See current usage: "5 / 10 seats used"
   - Add more seats through billing settings when needed

### **Managing Member Permissions**

**Role-Based Access Control:**
```typescript
// Permission hierarchy
Permission.read    // View content and participate
Permission.update  // Create and edit content  
Permission.share   // Manage sharing and invitations
```

**Organization Roles:**
- **Owner** - Full administrative access, billing management
- **Admin** - User management, content administration
- **Member** - Standard team access based on assigned permissions
- **Guest** - Limited read-only access to specific resources

### **Member Activity Tracking**

Monitor team productivity through:
- **Credit usage per member** - Track AI usage and costs
- **Activity feeds** - See what team members are working on
- **Recent activities** - Notebook creation, file uploads, collaborations
- **Usage analytics** - Understand team engagement and productivity

---

## 💳 **Billing & Subscription Management**

### **Team Subscription Plans**

**Pricing Structure:**
- **$X per seat/month** (pricing loaded dynamically from Stripe)
- **Minimum 4 seats** required for team plans
- **50,000 credits per seat** included monthly
- **Scalable billing** - add/remove seats as needed

### **Managing Subscriptions**

1. **Subscribe to Team Plan**
   - Navigate to Organization → Billing tab
   - Click **"Subscribe Now"**
   - Select number of seats needed
   - Complete Stripe checkout process

2. **Modify Seat Count**
   - Go to Billing → **"Manage Seats"**
   - Increase/decrease seats using the +/- controls
   - Changes reflected in next billing cycle
   - Minimum seats = current team size

3. **Billing Portal Access**
   - **"Manage Billing"** opens Stripe customer portal
   - Download invoices and payment history
   - Update payment methods and billing information
   - Cancel or modify subscriptions

### **Credit Management**

**Organization Credits:**
- **50,000 credits per seat** allocated monthly
- **Shared credit pool** across all team members
- **Usage tracking** per member for cost allocation
- **Automatic renewal** with subscription billing

**Credit Allocation:**
```typescript
// Credit calculation
const monthlyCredits = seats * 50000;
const totalCredits = monthlyCredits * subscriptionMonths;
```

---

## 🔐 **Security & Access Control**

### **Permission System**

**Granular Permissions:**
- **Resource-level control** - Notebooks, files, projects
- **Action-based permissions** - Read, write, share, delete
- **Inheritance rules** - Organization → Project → Resource
- **Override capabilities** - Specific sharing permissions

### **Access Control Examples**

```typescript
// Organization member permissions
{
  userId: "user123",
  permissions: [Permission.read, Permission.write],
  role: "member"
}

// Resource sharing
{
  resourceId: "notebook456", 
  sharedWith: [
    { userId: "user789", permissions: [Permission.read] }
  ],
  isGlobalRead: false
}
```

### **Security Features**

- **Invitation-only access** - Members must be explicitly invited
- **Email verification** - Confirmed email addresses required
- **Permission validation** - Server-side permission checking
- **Audit trails** - Track all permission changes and access

---

## 📊 **Analytics & Reporting**

### **Organization Dashboard**

**Key Metrics:**
- **Seat utilization** - Active vs. total seats
- **Credit consumption** - Usage patterns and trends
- **Member activity** - Engagement and productivity metrics
- **Billing status** - Subscription health and payment status

### **Usage Analytics**

**Team Performance Insights:**
- **Most active members** - Credit usage and activity levels
- **Popular content** - Most shared notebooks and files
- **Collaboration patterns** - Cross-team sharing and engagement
- **Cost optimization** - Seat utilization and credit efficiency

### **Reporting Features**

- **Usage reports** - Monthly team activity summaries
- **Billing reports** - Cost breakdowns and forecasting
- **Activity feeds** - Real-time team collaboration updates
- **Export capabilities** - Data export for external analysis

---

## 🔄 **Integration & Workflow**

### **Team Collaboration Workflows**

**1. Project-Based Collaboration:**
```
Create Organization → Invite Team → Create Shared Projects → 
Collaborate on Notebooks → Share Results → Track Progress
```

**2. Knowledge Sharing:**
```
Upload Team Files → Process with AI → Share Insights → 
Build Knowledge Base → Enable Team Discovery
```

**3. Resource Management:**
```
Monitor Usage → Optimize Seat Allocation → Manage Credits → 
Scale as Needed → Track ROI
```

### **API Integration**

Organizations integrate seamlessly with:
- **Authentication system** - SSO and user management
- **Billing platform** - Stripe subscription management
- **Activity tracking** - Real-time collaboration updates
- **Permission engine** - Granular access control

---

## 🎯 **Best Practices**

### **Organization Setup**

1. **Plan Your Structure**
   - Define clear team roles and responsibilities
   - Set up logical project hierarchies
   - Establish sharing and collaboration guidelines

2. **Optimize Seat Usage**
   - Start with minimum required seats
   - Monitor utilization regularly
   - Scale up/down based on actual usage

3. **Manage Permissions Carefully**
   - Use least-privilege principle
   - Regular permission audits
   - Clear escalation paths for access requests

### **Cost Optimization**

1. **Monitor Credit Usage**
   - Track per-member consumption
   - Identify high-usage patterns
   - Optimize AI model selection for cost

2. **Seat Management**
   - Regular seat utilization reviews
   - Remove inactive members promptly
   - Plan seasonal scaling needs

3. **Billing Optimization**
   - Annual vs. monthly billing considerations
   - Usage forecasting for budget planning
   - Cost allocation across departments

---

## 🔧 **Advanced Features**

### **Enterprise Capabilities**

- **Custom branding** - Organization logos and themes
- **Advanced analytics** - Detailed usage and performance metrics
- **API access** - Programmatic organization management
- **Bulk operations** - Mass user management and content operations

### **Integration Options**

- **SSO integration** - Enterprise authentication systems
- **Billing integration** - Custom billing and invoicing
- **Analytics integration** - Export to business intelligence tools
- **Compliance features** - Audit logs and data governance

---

## Related Features

- [Projects](./projects.md) - Team project collaboration
- [Profile & Settings](./profile-settings.md) - Account and security settings
- [Notebooks](./notebooks.md) - Shared team conversations
- [Knowledge Management](./knowledge-management.md) - Team knowledge bases

---

*Organizations & Team Management enables Bike4Mind to scale from individual productivity to enterprise collaboration, providing the structure and controls needed for teams to work together effectively while maintaining security and cost control.* 